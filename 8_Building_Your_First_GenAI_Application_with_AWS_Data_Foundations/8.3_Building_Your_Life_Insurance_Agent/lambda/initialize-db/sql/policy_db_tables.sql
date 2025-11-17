-- lambda/initialize-db/sql/policy_db_tables.sql

-- Create schema if it doesn't exist
CREATE SCHEMA IF NOT EXISTS ${POLICY_SCHEMA};

-- Set search path
SET search_path TO ${POLICY_SCHEMA}, public;

-- Create policies table
CREATE TABLE IF NOT EXISTS ${POLICIES_TABLE} (
    policy_number VARCHAR(15) PRIMARY KEY,
    policy_type VARCHAR(50) NOT NULL,
    policy_status VARCHAR(20) NOT NULL,
    issue_date DATE NOT NULL,
    face_amount DECIMAL(12,2) NOT NULL,
    policy_owner VARCHAR(100) NOT NULL,
    owner_date_of_birth DATE NOT NULL,
    insured_person VARCHAR(100) NOT NULL,
    created_at TIMESTAMP WITH TIME ZONE DEFAULT CURRENT_TIMESTAMP,
    updated_at TIMESTAMP WITH TIME ZONE DEFAULT CURRENT_TIMESTAMP
);

-- Create premiums table
CREATE TABLE IF NOT EXISTS ${PREMIUMS_TABLE} (
    premium_id SERIAL PRIMARY KEY,
    policy_number VARCHAR(15) REFERENCES ${POLICIES_TABLE}(policy_number),
    premium_amount DECIMAL(10,2) NOT NULL,
    premium_frequency VARCHAR(20) NOT NULL,
    next_due_date DATE NOT NULL,
    created_at TIMESTAMP WITH TIME ZONE DEFAULT CURRENT_TIMESTAMP,
    updated_at TIMESTAMP WITH TIME ZONE DEFAULT CURRENT_TIMESTAMP
);

-- Create addresses table
CREATE TABLE IF NOT EXISTS ${ADDRESSES_TABLE} (
    address_id SERIAL PRIMARY KEY,
    policy_number VARCHAR(15) REFERENCES ${POLICIES_TABLE}(policy_number),
    address_type VARCHAR(20) NOT NULL,
    street_address VARCHAR(100) NOT NULL,
    city VARCHAR(50) NOT NULL,
    state VARCHAR(2) NOT NULL,
    zip_code VARCHAR(10) NOT NULL,
    is_current BOOLEAN DEFAULT true,
    created_at TIMESTAMP WITH TIME ZONE DEFAULT CURRENT_TIMESTAMP,
    updated_at TIMESTAMP WITH TIME ZONE DEFAULT CURRENT_TIMESTAMP,
    CONSTRAINT unique_current_address UNIQUE (policy_number, address_type, is_current)
);

-- Remove the problematic unique constraint
ALTER TABLE ${ADDRESSES_TABLE} 
DROP CONSTRAINT IF EXISTS unique_current_address;

-- Add a new constraint that only enforces one current address per type
CREATE UNIQUE INDEX IF NOT EXISTS current_address_idx 
ON ${ADDRESSES_TABLE} (policy_number, address_type) 
WHERE is_current = true;

-- Create beneficiaries table
CREATE TABLE IF NOT EXISTS ${BENEFICIARIES_TABLE} (
    beneficiary_id SERIAL PRIMARY KEY,
    policy_number VARCHAR(15) REFERENCES ${POLICIES_TABLE}(policy_number),
    beneficiary_name VARCHAR(100) NOT NULL,
    date_of_birth DATE,
    relationship VARCHAR(50) NOT NULL,
    percentage DECIMAL(5,2) NOT NULL,
    is_primary BOOLEAN DEFAULT true,
    created_at TIMESTAMP WITH TIME ZONE DEFAULT CURRENT_TIMESTAMP,
    updated_at TIMESTAMP WITH TIME ZONE DEFAULT CURRENT_TIMESTAMP,
    CONSTRAINT valid_percentage CHECK (percentage > 0 AND percentage <= 100)
);

-- Create payment methods table
CREATE TABLE IF NOT EXISTS ${PAYMENT_METHODS_TABLE} (
    payment_method_id SERIAL PRIMARY KEY,
    policy_number VARCHAR(15) REFERENCES ${POLICIES_TABLE}(policy_number),
    payment_type VARCHAR(20) NOT NULL,
    card_number VARCHAR(255),
    card_last_four VARCHAR(4),
    account_number VARCHAR(255),
    routing_number VARCHAR(255),
    expiration_date DATE,
    is_default BOOLEAN DEFAULT false,
    status VARCHAR(20) DEFAULT 'ACTIVE',
    created_at TIMESTAMP WITH TIME ZONE DEFAULT CURRENT_TIMESTAMP,
    updated_at TIMESTAMP WITH TIME ZONE DEFAULT CURRENT_TIMESTAMP
);

-- Remove unique constraint
ALTER TABLE ${PAYMENT_METHODS_TABLE}
DROP CONSTRAINT IF EXISTS unique_default_payment;

-- Add unique constraint for default payment methods
CREATE UNIQUE INDEX IF NOT EXISTS unique_default_payment
ON ${PAYMENT_METHODS_TABLE} (policy_number)
WHERE is_default = true;

-- Create payment history table
CREATE TABLE IF NOT EXISTS ${PAYMENT_HISTORY_TABLE} (
    payment_id SERIAL PRIMARY KEY,
    policy_number VARCHAR(15) REFERENCES ${POLICIES_TABLE}(policy_number),
    payment_method_id INTEGER REFERENCES ${PAYMENT_METHODS_TABLE}(payment_method_id),
    payment_amount DECIMAL(10,2) NOT NULL,
    payment_date DATE NOT NULL,
    payment_status VARCHAR(20) NOT NULL,
    created_at TIMESTAMP WITH TIME ZONE DEFAULT CURRENT_TIMESTAMP,
    updated_at TIMESTAMP WITH TIME ZONE DEFAULT CURRENT_TIMESTAMP
);

-- Create policy valuations table
CREATE TABLE IF NOT EXISTS ${POLICY_SCHEMA}.policy_valuations (
    valuation_id SERIAL PRIMARY KEY,
    policy_number VARCHAR(15) REFERENCES ${POLICIES_TABLE}(policy_number),
    net_cash_surrender DECIMAL(12,2) NOT NULL,
    valuation_date DATE NOT NULL,
    created_at TIMESTAMP WITH TIME ZONE DEFAULT CURRENT_TIMESTAMP,
    CONSTRAINT unique_policy_valuation UNIQUE (policy_number, valuation_date)
);

-- Create indexes
CREATE INDEX IF NOT EXISTS idx_policies_owner ON ${POLICIES_TABLE}(policy_owner);
CREATE INDEX IF NOT EXISTS idx_policies_insured ON ${POLICIES_TABLE}(insured_person);
CREATE INDEX IF NOT EXISTS idx_premiums_policy ON ${PREMIUMS_TABLE}(policy_number);
CREATE INDEX IF NOT EXISTS idx_addresses_policy ON ${ADDRESSES_TABLE}(policy_number);
CREATE INDEX IF NOT EXISTS idx_beneficiaries_policy ON ${BENEFICIARIES_TABLE}(policy_number);
CREATE INDEX IF NOT EXISTS idx_payment_methods_policy ON ${PAYMENT_METHODS_TABLE}(policy_number);
CREATE INDEX IF NOT EXISTS idx_payment_history_policy ON ${PAYMENT_HISTORY_TABLE}(policy_number);
CREATE INDEX IF NOT EXISTS idx_policy_valuations_policy ON ${POLICY_SCHEMA}.policy_valuations(policy_number);
CREATE INDEX IF NOT EXISTS idx_policy_valuations_date ON ${POLICY_SCHEMA}.policy_valuations(valuation_date);
