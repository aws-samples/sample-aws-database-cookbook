// lambda/action-groups/make-payment/index.js

const { PolicyDbClient } = require('./shared/policy-db-client');

function formatErrorResponse(httpStatusCode, message, event) {
    return {
        messageVersion: '1.0',
        response: {
            actionGroup: event.actionGroup,
            apiPath: event.apiPath,
            httpMethod: event.httpMethod,
            httpStatusCode: httpStatusCode,
            responseBody: {
                'application/json': {
                    body: JSON.stringify({
                        error: message
                    })
                }
            }
        }
    };
}

function convertExpirationDate(dateStr) {
    try {
        // Validate YYYY-MM-DD format
        if (!/^\d{4}-(0[1-9]|1[0-2])-(0[1-9]|[12]\d|3[01])$/.test(dateStr)) {
            throw new Error('Invalid expiration date format');
        }
        
        // Parse the date to ensure it's valid
        const date = new Date(dateStr);
        if (isNaN(date.getTime())) {
            throw new Error('Invalid date');
        }
        
        // Return the date in YYYY-MM-DD format
        return dateStr;
    } catch (error) {
        throw new Error('Invalid expiration date format. Please use YYYY-MM-DD format.');
    }
}

exports.handler = async (event) => {
    console.log('\n=== Starting make-payment handler ===');
    console.log('Event:', JSON.stringify(event, null, 2));

    try {
        const props = event.requestBody.content['application/json'].properties;
        const payment = {
            policyNumber: props.find(p => p.name === 'policyNumber')?.value?.trim(),
            paymentAmount: parseFloat(props.find(p => p.name === 'paymentAmount')?.value || '0'),
            cardNumber: props.find(p => p.name === 'cardNumber')?.value?.trim(),
            expirationDate: props.find(p => p.name === 'expirationDate')?.value?.trim(),
            cvv: props.find(p => p.name === 'cvv')?.value?.trim(),
        };

        console.log('Payment details:', JSON.stringify({
            ...payment,
            cardNumber: payment.cardNumber ? `****${payment.cardNumber.slice(-4)}` : null,
            cvv: payment.cvv ? '***' : null
        }));

        if (!payment.policyNumber || !payment.paymentAmount) {
            return formatErrorResponse(400, 'Missing required payment information', event);
        }

        const dbClient = new PolicyDbClient();

        // Check if card exists, if not store it as new payment method
        const lastFour = payment.cardNumber.slice(-4);
        let storedCard = await dbClient.getStoredCard(payment.policyNumber, lastFour);
        
        if (!storedCard) {
            console.log('Card not found, storing as new payment method');
            // Store new payment method
            const newPaymentMethod = {
                paymentType: 'CREDIT_CARD',
                cardLastFour: lastFour,
                expirationDate: payment.expirationDate,
                isDefault: false
            };
            await dbClient.storePaymentMethod(payment.policyNumber, newPaymentMethod);
            storedCard = { payment_type: 'CREDIT_CARD', card_last_four: lastFour };
        }

        let convertedExpirationDate;
        try {
            convertedExpirationDate = convertExpirationDate(payment.expirationDate);
        } catch (error) {
            return formatErrorResponse(400, error.message, event);
        }

        const paymentDetails = {
            paymentAmount: payment.paymentAmount,
            cardLastFour: payment.cardNumber ? payment.cardNumber.slice(-4) : '****',
            paymentType: 'CREDIT_CARD',
            expirationDate: convertedExpirationDate
        };

        console.log('Processing payment with details:', {
            paymentAmount: paymentDetails.paymentAmount,
            cardLastFour: `****${paymentDetails.cardLastFour}`,
            paymentType: paymentDetails.paymentType,
            expirationDate: paymentDetails.expirationDate
        });

        const result = await dbClient.recordPayment(payment.policyNumber, paymentDetails);

        const responseData = {
            transactionId: result.payment.paymentId.toString(),
            paymentStatus: result.payment.status,
            paymentAmount: parseFloat(result.payment.amount),
            paymentDate: result.payment.paymentDate.toISOString().split('T')[0],
            paymentMethod: {
                paymentType: result.paymentMethod?.payment_type || paymentDetails.paymentType,
                cardLastFour: result.paymentMethod?.card_last_four || paymentDetails.cardLastFour,
                expirationDate: payment.expirationDate
            },
            paymentHistory: [{
                transactionId: result.payment.paymentId.toString(),
                paymentDate: result.payment.paymentDate.toISOString().split('T')[0],
                paymentAmount: parseFloat(result.payment.amount),
                paymentStatus: result.payment.status,
                cardLastFour: result.paymentMethod?.card_last_four || paymentDetails.cardLastFour
            }]
        };

        return {
            messageVersion: '1.0',
            response: {
                actionGroup: event.actionGroup,
                apiPath: event.apiPath,
                httpMethod: event.httpMethod,
                httpStatusCode: 200,
                responseBody: {
                    'application/json': {
                        body: JSON.stringify(responseData)
                    }
                }
            }
        };

    } catch (error) {
        console.error('Error in handler:', error);
        const statusCode = error.message.includes('not found') ? 404 : 500;
        return formatErrorResponse(statusCode, 
            statusCode === 404 ? 'Policy not found' : 
            'An error occurred while processing your payment. Please try again or contact customer service.',
            event
        );
    }
};
