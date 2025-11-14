// lambda/action-groups/shared/policy-db-client.js

const { SecretsManagerClient, GetSecretValueCommand } = require('@aws-sdk/client-secrets-manager');
const { Pool } = require('pg');

class PolicyDbClient {
    constructor() {
        this.secretsManager = new SecretsManagerClient();
        this.pool = null;
    }

    async getDbCredentials() {
        if (!process.env.SECRET_NAME) {
            throw new Error('SECRET_NAME environment variable not set');
        }

        const command = new GetSecretValueCommand({
            SecretId: process.env.SECRET_NAME
        });

        try {
            const response = await this.secretsManager.send(command);
            return JSON.parse(response.SecretString);
        } catch (error) {
            console.error('Error fetching database credentials:', error);
            throw new Error('Failed to retrieve database credentials');
        }
    }

    async getPool() {
        if (this.pool) {
            return this.pool;
        }

        const credentials = await this.getDbCredentials();
        
        this.pool = new Pool({
            host: credentials.host,
            port: credentials.port,
            database: credentials.dbname,
            user: credentials.username,
            password: credentials.password,
            ssl: {
                rejectUnauthorized: false // Required for AWS RDS SSL
            },
            // Connection pool settings
            max: 20,
            idleTimeoutMillis: 30000,
            connectionTimeoutMillis: 2000,
            maxUses: 7500
        });

        this.pool.on('error', (err, client) => {
            console.error('Unexpected error on idle client', err);
        });

        return this.pool;
    }

    async executeQuery(query, params = []) {
        const pool = await this.getPool();
        const client = await pool.connect();
        
        try {
            console.log('Executing query:', {
                query: query.replace(/\$\d+/g, '?'),
                paramCount: params.length
            });

            const result = await client.query(query, params);
            
            console.log('Query completed:', {
                rowCount: result.rowCount,
                fields: result.fields.map(f => f.name)
            });

            return result.rows;
        } catch (error) {
            console.error('Database query error:', {
                code: error.code,
                message: error.message,
                detail: error.detail,
                hint: error.hint,
                position: error.position,
                query: query.replace(/\$\d+/g, '?'),
                paramCount: params.length
            });
            throw error;
        } finally {
            client.release();
        }
    }

    async executeTransaction(queries) {
        const pool = await this.getPool();
        const client = await pool.connect();
        
        try {
            await client.query('BEGIN');
            
            const results = [];
            for (const { query, params } of queries) {
                const result = await client.query(query, params);
                results.push(result.rows);
            }
            
            await client.query('COMMIT');
            return results;
        } catch (error) {
            await client.query('ROLLBACK');
            console.error('Transaction error:', {
                code: error.code,
                message: error.message,
                detail: error.detail
            });
            throw error;
        } finally {
            client.release();
        }
    }

    // Payment methods
    async getStoredCard(policyNumber, lastFour) {
        const query = `
            SELECT 
                payment_type,
                card_last_four
            FROM ${process.env.POLICY_SCHEMA}.${process.env.PAYMENT_METHODS_TABLE}
            WHERE policy_number = $1 
                AND card_last_four = $2
                AND is_default = true
            LIMIT 1
        `;
        
        try {
            console.log('Validating stored card:', {
                policyNumber,
                lastFour
            });

            const results = await this.executeQuery(query, [policyNumber, lastFour]);
            
            if (results.length === 0) {
                console.log('No matching card found');
                return null;
            }

            return {
                paymentType: results[0].payment_type,
                cardLastFour: results[0].card_last_four
            };
        } catch (error) {
            console.error('Error validating stored card:', error);
            throw error;
        }
    }

    // Get Policy Details methods
    async getPolicyDetails(policyNumber) {
        const query = `
            WITH latest_premium AS (
                SELECT *
                FROM ${process.env.POLICY_SCHEMA}.${process.env.PREMIUMS_TABLE}
                WHERE policy_number = $1
                ORDER BY next_due_date DESC
                LIMIT 1
            )
            SELECT 
                p.*,
                pv.net_cash_surrender,
                pv.valuation_date,
                pm.premium_amount,
                pm.premium_frequency,
                pm.next_due_date,
                COALESCE(
                    json_agg(
                        json_build_object(
                            'beneficiary_id', b.beneficiary_id,
                            'beneficiary_name', b.beneficiary_name,
                            'relationship', b.relationship,
                            'percentage', b.percentage,
                            'is_primary', b.is_primary
                        )
                    ) FILTER (WHERE b.beneficiary_id IS NOT NULL),
                    '[]'
                ) as beneficiaries,
                (
                    SELECT json_build_object(
                        'street_address', a.street_address,
                        'city', a.city,
                        'state', a.state,
                        'zip_code', a.zip_code
                    )
                    FROM ${process.env.POLICY_SCHEMA}.${process.env.ADDRESSES_TABLE} a
                    WHERE a.policy_number = p.policy_number
                    AND a.is_current = true
                    LIMIT 1
                ) as current_address,
                (
                    SELECT json_build_object(
                        'payment_amount', ph.payment_amount,
                        'payment_date', ph.payment_date,
                        'payment_status', ph.payment_status
                    )
                    FROM ${process.env.POLICY_SCHEMA}.${process.env.PAYMENT_HISTORY_TABLE} ph
                    WHERE ph.policy_number = p.policy_number
                    ORDER BY ph.payment_date DESC, ph.created_at DESC
                    LIMIT 1
                ) as last_payment
            FROM ${process.env.POLICY_SCHEMA}.${process.env.POLICIES_TABLE} p
            LEFT JOIN ${process.env.POLICY_SCHEMA}.${process.env.BENEFICIARIES_TABLE} b 
                ON p.policy_number = b.policy_number
            LEFT JOIN ${process.env.POLICY_SCHEMA}.policy_valuations pv
                ON p.policy_number = pv.policy_number
                AND pv.valuation_date = (
                    SELECT MAX(valuation_date)
                    FROM ${process.env.POLICY_SCHEMA}.policy_valuations
                    WHERE policy_number = p.policy_number
                )
            LEFT JOIN latest_premium pm
                ON p.policy_number = pm.policy_number
            WHERE p.policy_number = $1
            GROUP BY 
                p.policy_number,
                p.policy_type,
                p.policy_status,
                p.issue_date,
                p.face_amount,
                p.policy_owner,
                p.insured_person,
                p.created_at,
                p.updated_at,
                pv.net_cash_surrender,
                pv.valuation_date,
                pm.premium_amount,
                pm.premium_frequency,
                pm.next_due_date
        `;

        const results = await this.executeQuery(query, [policyNumber]);
        return results[0];
    }

    // Make Payment methods
    async recordPayment(policyNumber, paymentDetails) {
        console.log('Starting recordPayment:', {
            policyNumber,
            paymentAmount: paymentDetails.paymentAmount,
            cardLastFour: paymentDetails.cardLastFour ? '****' : undefined,
            paymentType: paymentDetails.paymentType,
            hasExpirationDate: !!paymentDetails.expirationDate
        });

        const { paymentAmount, cardLastFour, paymentType, expirationDate } = paymentDetails;
        const paymentDate = new Date().toISOString().split('T')[0];

        if (!paymentAmount || paymentAmount <= 0) {
            throw new Error('Invalid payment amount');
        }

        const queries = [
            {
                query: `
                    INSERT INTO ${process.env.POLICY_SCHEMA}.${process.env.PAYMENT_HISTORY_TABLE}
                    (policy_number, payment_amount, payment_date, payment_status)
                    VALUES ($1, $2, $3, $4)
                    RETURNING 
                        payment_id as "paymentId",
                        policy_number as "policyNumber",
                        payment_amount as "paymentAmount",
                        payment_date as "paymentDate",
                        payment_status as "paymentStatus",
                        created_at as "createdAt"
                `,
                params: [policyNumber, paymentAmount, paymentDate, 'COMPLETED']
            }
        ];

        if (cardLastFour && expirationDate) {
            queries.push({
                query: `
                    UPDATE ${process.env.POLICY_SCHEMA}.${process.env.PAYMENT_METHODS_TABLE}
                    SET 
                        is_default = false,
                        updated_at = CURRENT_TIMESTAMP
                    WHERE policy_number = $1 
                    AND is_default = true
                    RETURNING 
                        payment_method_id as "paymentMethodId",
                        payment_type as "paymentType",
                        card_last_four as "cardLastFour",
                        expiration_date as "expirationDate",
                        is_default as "isDefault",
                        status
                `,
                params: [policyNumber]
            });

            queries.push({
                query: `
                    INSERT INTO ${process.env.POLICY_SCHEMA}.${process.env.PAYMENT_METHODS_TABLE}
                    (policy_number, payment_type, card_last_four, expiration_date, is_default)
                    VALUES ($1, $2, $3, $4, true)
                    RETURNING 
                        payment_method_id as "paymentMethodId",
                        payment_type as "paymentType",
                        card_last_four as "cardLastFour",
                        expiration_date as "expirationDate",
                        is_default as "isDefault",
                        created_at as "createdAt"
                `,
                params: [policyNumber, paymentType, cardLastFour, expirationDate]
            });
        }

        try {
            console.log('Executing payment transaction:', {
                queryCount: queries.length,
                queries: queries.map(q => ({
                    query: q.query.replace(/\s+/g, ' ').trim(),
                    paramCount: q.params.length
                }))
            });

            const results = await this.executeTransaction(queries);

            const paymentRecord = results[0][0];
            const paymentMethodRecord = queries.length > 1 ? results[results.length - 1][0] : null;

            console.log('Payment recorded successfully:', {
                paymentId: paymentRecord.paymentId,
                paymentAmount: paymentRecord.paymentAmount,
                paymentDate: paymentRecord.paymentDate,
                paymentStatus: paymentRecord.paymentStatus,
                paymentMethodId: paymentMethodRecord?.paymentMethodId
            });

            return {
                payment: {
                    ...paymentRecord,
                    paymentAmount: parseFloat(paymentRecord.paymentAmount)
                },
                paymentMethod: paymentMethodRecord ? {
                    ...paymentMethodRecord,
                    isDefault: paymentMethodRecord.isDefault === 'true'
                } : null
            };

        } catch (error) {
            console.error('Error in recordPayment transaction:', {
                error: {
                    code: error.code,
                    message: error.message,
                    detail: error.detail,
                    constraint: error.constraint
                },
                policyNumber
            });

            if (error.code === '23505' && error.constraint === 'unique_default_payment') {
                throw new Error('Failed to update payment method: default payment conflict');
            }

            throw error;
        }
    }

    // Update Address methods
    async updateAddress(policyNumber, addressDetails) {
        const { streetAddress, city, state, zipCode, addressType = 'PRIMARY' } = addressDetails;
        
        try {
            // Get current address first
            const currentAddressResult = await this.executeQuery(
                `SELECT * FROM ${process.env.POLICY_SCHEMA}.${process.env.ADDRESSES_TABLE}
                 WHERE policy_number = $1 
                 AND address_type = $2 
                 AND is_current = true`,
                [policyNumber, addressType]
            );
            
            const currentAddress = currentAddressResult[0];
            
            // Begin transaction
            const queries = [];
            
            // If there's a current address, update it to not current
            if (currentAddress) {
                queries.push({
                    query: `
                        UPDATE ${process.env.POLICY_SCHEMA}.${process.env.ADDRESSES_TABLE}
                        SET is_current = false, 
                            updated_at = CURRENT_TIMESTAMP
                        WHERE address_id = $1
                        RETURNING address_id
                    `,
                    params: [currentAddress.address_id]
                });
            }
            
            // Insert new address
            queries.push({
                query: `
                    INSERT INTO ${process.env.POLICY_SCHEMA}.${process.env.ADDRESSES_TABLE}
                    (policy_number, address_type, street_address, city, state, zip_code, is_current)
                    VALUES ($1, $2, $3, $4, $5, $6, true)
                    RETURNING 
                        address_id as "addressId",
                        address_type as "addressType",
                        street_address as "streetAddress",
                        city,
                        state,
                        zip_code as "zipCode",
                        is_current as "isCurrent",
                        created_at as "createdAt"
                `,
                params: [
                    policyNumber,
                    addressType,
                    streetAddress || currentAddress?.street_address,
                    city || currentAddress?.city,
                    state || currentAddress?.state,
                    zipCode || currentAddress?.zip_code
                ]
            });

            const results = await this.executeTransaction(queries);
            
            return {
                status: 'COMPLETED',
                address: results[results.length - 1][0],
                updateTimestamp: new Date().toISOString()
            };

        } catch (error) {
            console.error('Error in updateAddress:', error);
            throw error;
        }
    }

    // Update Beneficiary methods
    async updateBeneficiaries(policyNumber, beneficiaries) {
        if (!Array.isArray(beneficiaries)) {
            throw new Error('Beneficiaries must be an array');
        }

        const queries = [{
            query: `
                DELETE FROM ${process.env.POLICY_SCHEMA}.${process.env.BENEFICIARIES_TABLE}
                WHERE policy_number = $1
            `,
            params: [policyNumber]
        }];

        beneficiaries.forEach((beneficiary, index) => {
            const requiredFields = ['beneficiaryName', 'relationship', 'percentage'];
            for (const field of requiredFields) {
                if (!beneficiary[field]) {
                    throw new Error(`Missing required field '${field}' for beneficiary ${index + 1}`);
                }
            }

            queries.push({
                query: `
                    INSERT INTO ${process.env.POLICY_SCHEMA}.${process.env.BENEFICIARIES_TABLE}
                    (policy_number, beneficiary_name, date_of_birth, relationship, percentage, is_primary)
                    VALUES ($1, $2, $3, $4, $5, $6)
                    RETURNING
                        beneficiary_id as "beneficiaryId",
                        beneficiary_name as "beneficiaryName",
                        date_of_birth as "dateOfBirth",
                        relationship,
                        percentage,
                        is_primary as "isPrimary"
                `,
                params: [
                    policyNumber,
                    beneficiary.beneficiaryName,
                    beneficiary.dateOfBirth,
                    beneficiary.relationship.toUpperCase(),
                    parseFloat(beneficiary.percentage),
                    beneficiary.isPrimary || false
                ]
            });
        });

        try {
            const results = await this.executeTransaction(queries);
            const updatedBeneficiaries = results.slice(1).flat().map(b => ({
                ...b,
                percentage: parseFloat(b.percentage),
                isPrimary: b.isPrimary === 'true'
            }));
            console.log('Beneficiary update completed successfully:', {
                policyNumber,
                beneficiaryCount: updatedBeneficiaries.length
            });
            return {
                status: 'COMPLETED',
                beneficiaries: updatedBeneficiaries,
                updateTimestamp: new Date().toISOString()
            };
        } catch (error) {
            console.error('Error updating beneficiaries:', {
                code: error.code,
                message: error.message,
                detail: error.detail
            });
            throw error;
        }
    }

    async cleanup() {
        if (this.pool) {
            await this.pool.end();
            this.pool = null;
        }
    }
}

module.exports = { PolicyDbClient };
