#!/bin/bash

# Life Insurance Agent CDK Context Configuration Script
# For use in SageMaker Notebook environments

set -e

echo "🔧 Configuring CDK Context for Life Insurance Agent..."

# Get AWS account ID and region
ACCOUNT_ID=$(aws sts get-caller-identity --query Account --output text 2>/dev/null || echo "")
REGION=$(aws configure get region 2>/dev/null || echo "us-east-1")

if [ -z "$ACCOUNT_ID" ]; then
    echo "❌ Unable to retrieve AWS Account ID automatically."
    read -p "Please enter your AWS Account ID: " ACCOUNT_ID
fi

echo "📋 Using AWS Account: $ACCOUNT_ID"
echo "📍 Using AWS Region: $REGION"

# Check if region has at least 3 availability zones
echo "🔍 Checking availability zones in $REGION..."
AZ_COUNT=$(aws ec2 describe-availability-zones --region $REGION --query 'length(AvailabilityZones)' --output text 2>/dev/null || echo "0")

if [ "$AZ_COUNT" -lt 3 ]; then
    echo "❌ Region $REGION only has $AZ_COUNT availability zones. This application requires at least 3 AZs."
    echo "   Consider using regions like us-east-1, us-west-2, or eu-west-1 which have 3+ AZs."
    exit 1
fi

echo "✅ Region $REGION has $AZ_COUNT availability zones (minimum 3 required)"

# Prompt for required values
read -p "Enter your GitHub username/organization (default: your-github-username): " GITHUB_OWNER
GITHUB_OWNER=${GITHUB_OWNER:-"your-github-username"}

read -p "Enter your GitHub repository name (default: db-cookbook): " GITHUB_REPO
GITHUB_REPO=${GITHUB_REPO:-"db-cookbook"}

read -p "Enter your GitHub branch (default: main): " GITHUB_BRANCH
GITHUB_BRANCH=${GITHUB_BRANCH:-"main"}

echo ""
echo "⚠️  You need to create a GitHub connection in AWS CodePipeline first."
echo "   Visit: https://console.aws.amazon.com/codesuite/codepipeline/start"
echo "   Go to Settings > Connections > Create connection"
echo ""
read -p "Enter your CodePipeline GitHub connection ARN: " CONNECTION_ARN

if [ -z "$CONNECTION_ARN" ]; then
    echo "❌ Connection ARN is required. Please create a GitHub connection first."
    exit 1
fi

# Generate unique app name
APP_NAME="lifeins-$(date +%s | tail -c 5)"
echo "🏷️  Generated app name: $APP_NAME"

# Create the context configuration
cat > cdk.context.json << EOF
{
  "app": {
    "name": "$APP_NAME",
    "title": "Life Insurance Agent",
    "icon": "🏥",
    "chatPrompt": "How can I help with your life insurance needs?"
  },
  "resources": {
    "naming": {
      "bucket": "{app.name}-{purpose}-{account}-{region}",
      "function": "{app.name}-{purpose}",
      "layer": "{app.name}-{purpose}",
      "table": "{app.name}-{purpose}",
      "database": "{app.name}-{purpose}",
      "cluster": "{app.name}-{purpose}",
      "role": "{app.name}-{purpose}",
      "agent": "{app.name}-{purpose}",
      "knowledgeBase": "{app.name}-{purpose}",
      "guardrail": "{app.name}-{purpose}",
      "userPool": "{app.name}-{purpose}",
      "userPoolClient": "{app.name}-{purpose}",
      "service": "{app.name}-{purpose}",
      "taskDefinition": "{app.name}-{purpose}",
      "securityGroup": "{app.name}-{purpose}",
      "secret": "{app.name}-{purpose}",
      "pipeline": "{app.name}-{purpose}",
      "project": "{app.name}-{purpose}",
      "logGroup": "{app.name}-{purpose}",
      "alarm": "{app.name}-{purpose}",
      "vpc": "{app.name}-vpc",
      "subnet": "{app.name}-{purpose}",
      "loadBalancer": "{app.name}-{purpose}",
      "targetGroup": "{app.name}-{purpose}"
    }
  },
  "bedrock": {
    "agent": {
      "foundationModel": "anthropic.claude-3-haiku-20240307-v1:0",
      "idleSessionTTLInSeconds": 3600,
      "maxTokens": 2048,
      "temperature": 0,
      "topP": 0.9,
      "numResults": 5
    },
    "knowledge_base": {
      "embeddingModel": "amazon.titan-embed-text-v2:0"
    }
  },
  "cognito": {
    "secrets_manager_id": "{app.name}-cognito-params",
    "tempPassword": "ChangeMe123!"
  },
  "vpc": {
    "cidr": "10.0.0.0/16",
    "maxAzs": 3,
    "natGateways": 1,
    "subnetConfiguration": {
      "public": {
        "cidrMask": 24,
        "name": "Public"
      },
      "private": {
        "cidrMask": 24,
        "name": "Private"
      },
      "isolated": {
        "cidrMask": 24,
        "name": "Isolated"
      }
    }
  },
  "databases": {
    "policy": {
      "cluster": {
        "name": "policydb1"
      },
      "schema": "policyschema",
      "tables": {
        "policies": "policies",
        "premiums": "premiums",
        "addresses": "addresses",
        "beneficiaries": "beneficiaries",
        "payment_history": "payment_history",
        "payment_methods": "payment_methods"
      }
    },
    "knowledge": {
      "cluster": {
        "name": "kbdb1"
      },
      "schema": "bedrockintegration",
      "tables": {
        "bedrock_kb": "bedrock_kb",
        "documents": "kb_documents",
        "categories": "kb_categories",
        "document_categories": "kb_document_categories"
      }
    }
  },
  "s3": {
    "folders": {
      "agent": "agent",
      "docs": "documents",
      "assets": "assets",
      "knowledgeBase": "knowledge-base"
    }
  },
  "container": {
    "port": 8501,
    "memory": 4096,
    "cpu": 1024,
    "desired_count": 3
  },
  "cloudfront": {
    "custom_header_name": "X-Custom-Header",
    "custom_header_value": "$(openssl rand -hex 16)"
  },
  "github": {
    "owner": "$GITHUB_OWNER",
    "repo": "$GITHUB_REPO",
    "branch": "$GITHUB_BRANCH"
  },
  "connection_arn": "$CONNECTION_ARN",
  "availability-zones:account=$ACCOUNT_ID:region=$REGION": [
    "${REGION}a",
    "${REGION}b",
    "${REGION}c"
  ]
}
EOF

echo ""
echo "✅ CDK context configuration completed!"
echo "📄 Configuration saved to: cdk.context.json"
echo ""
echo "🚀 Next steps:"
echo "   1. Run: cdk bootstrap"
echo "   2. Run: npm run build"
echo "   3. Run: cdk destroy --all --force --require-approval never --ci --context-from-config cdk.context.json --profile <YOUR_AWS_CLI_PROFILE>"
echo ""
echo "📋 Your configuration:"
echo "   App Name: $APP_NAME"
echo "   AWS Account: $ACCOUNT_ID"
echo "   AWS Region: $REGION"
echo "   GitHub: $GITHUB_OWNER/$GITHUB_REPO ($GITHUB_BRANCH)"