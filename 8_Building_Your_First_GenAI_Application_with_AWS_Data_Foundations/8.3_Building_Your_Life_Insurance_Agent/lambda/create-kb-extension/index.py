# lambda/create-kb-extension/index.py

import json
import boto3
import psycopg2
import urllib3
import os
from sqlalchemy import create_engine, text, DDL

def get_secret(secret_arn: str):
    """Get secret from AWS Secrets Manager"""
    client = boto3.client('secretsmanager')
    response = client.get_secret_value(SecretId=secret_arn)
    return json.loads(response['SecretString'])

def send_cfn_response(event, context, response_status, response_data, physical_resource_id=None, reason=None):
    response_body = json.dumps({
        'Status': response_status,
        'Reason': reason or f"See the details in CloudWatch Log Stream: {context.log_stream_name}",
        'PhysicalResourceId': physical_resource_id or context.log_stream_name,
        'StackId': event['StackId'],
        'RequestId': event['RequestId'],
        'LogicalResourceId': event['LogicalResourceId'],
        'Data': response_data
    })

    print(f"Response body:\n{response_body}")

    http = urllib3.PoolManager()
    try:
        http.request('PUT', event['ResponseURL'],
                     body=response_body,
                     headers={'Content-Type': 'application/json'})
    except Exception as e:
        print(f"Failed to send response: {str(e)}")

def handler(event, context):
    """Lambda handler"""
    print(f"Received event: {json.dumps(event)}")
    
    # Handle deletion
    if event['RequestType'] == 'Delete':
        send_cfn_response(event, context, 'SUCCESS', {})
        return
    
    try:
        # Get connection details from environment variables
        secret = get_secret(os.environ['SECRET_ARN'])
        db_name = os.environ['DB_NAME']
        
        # Connect to default database first
        engine = create_engine(f"postgresql://{secret['username']}:{secret['password']}@{os.environ['CLUSTER_ENDPOINT']}/postgres")
        connection = engine.connect()
        
        # Check if database exists
        result = connection.execute(
            text("SELECT 1 FROM pg_database WHERE datname = :name"),
            {"name": db_name}
        )
        
        if not result.fetchone():
            print(f"Creating {db_name} database...")
            connection.execute(text("COMMIT"))
            # Need to use DDL for CREATE DATABASE
            create_db = DDL(f"CREATE DATABASE {db_name}")
            connection.execute(create_db)
        
        connection.close()
        
        # Connect to knowledge_db database
        engine = create_engine(f"postgresql://{secret['username']}:{secret['password']}@{os.environ['CLUSTER_ENDPOINT']}/{db_name}")
        connection = engine.connect()
        connection.execute(text("COMMIT"))
        
        # Create vector extension
        print("Creating vector extension...")
        connection.execute(text('CREATE EXTENSION IF NOT EXISTS vector'))
        
        # Create the kb_documents table
        print("Creating kb_documents table...")
        connection.execute(text('''
            CREATE TABLE IF NOT EXISTS kb_documents (
                id SERIAL PRIMARY KEY,
                title TEXT NOT NULL,
                content TEXT NOT NULL,
                embedding vector(384),
                metadata JSONB,
                created_at TIMESTAMP WITH TIME ZONE DEFAULT CURRENT_TIMESTAMP,
                updated_at TIMESTAMP WITH TIME ZONE DEFAULT CURRENT_TIMESTAMP
            )
        '''))
        
        # Create categories table
        print("Creating kb_categories table...")
        connection.execute(text('''
            CREATE TABLE IF NOT EXISTS kb_categories (
                id SERIAL PRIMARY KEY,
                name VARCHAR(100) NOT NULL UNIQUE,
                description TEXT
            )
        '''))
        
        # Create junction table
        print("Creating kb_document_categories table...")
        connection.execute(text('''
            CREATE TABLE IF NOT EXISTS kb_document_categories (
                document_id INTEGER REFERENCES kb_documents(id),
                category_id INTEGER REFERENCES kb_categories(id),
                PRIMARY KEY (document_id, category_id)
            )
        '''))
        
        # Create update timestamp function
        print("Creating update timestamp function...")
        connection.execute(text('''
            CREATE OR REPLACE FUNCTION update_updated_at_column()
            RETURNS TRIGGER AS $$
            BEGIN
                NEW.updated_at = CURRENT_TIMESTAMP;
                RETURN NEW;
            END;
            $$ language 'plpgsql'
        '''))
        
        # Create trigger
        print("Creating update timestamp trigger...")
        connection.execute(text('''
            DROP TRIGGER IF EXISTS update_kb_documents_updated_at ON kb_documents;
            CREATE TRIGGER update_kb_documents_updated_at
                BEFORE UPDATE ON kb_documents
                FOR EACH ROW
                EXECUTE FUNCTION update_updated_at_column()
        '''))
        
        # Create index for vector similarity search
        print("Creating vector similarity index...")
        connection.execute(text('''
            CREATE INDEX IF NOT EXISTS kb_documents_embedding_idx ON kb_documents 
            USING ivfflat (embedding vector_cosine_ops) WITH (lists = 100)
        '''))
        
        connection.close()
        
        responseData = {'Message': 'Successfully created vector extension and tables'}
        send_cfn_response(event, context, 'SUCCESS', responseData)
        
    except Exception as e:
        print(f"Error: {str(e)}")
        send_cfn_response(
            event,
            context,
            'FAILED',
            {'Error': str(e)},
            reason=str(e)
        )
        
    finally:
        if 'connection' in locals() and connection is not None:
            connection.close()
