// lib/streamlit-stack.ts

import * as fs from 'fs';
import * as path from 'path';
import * as cdk from 'aws-cdk-lib';
import * as s3 from 'aws-cdk-lib/aws-s3';
import * as ec2 from 'aws-cdk-lib/aws-ec2';
import * as ecs from 'aws-cdk-lib/aws-ecs';
import * as ecr from 'aws-cdk-lib/aws-ecr';
import * as iam from 'aws-cdk-lib/aws-iam';
import * as logs from 'aws-cdk-lib/aws-logs';
import * as lambda from 'aws-cdk-lib/aws-lambda';
import * as cr from 'aws-cdk-lib/custom-resources';
import * as cognito from 'aws-cdk-lib/aws-cognito';
import * as dynamodb from 'aws-cdk-lib/aws-dynamodb';
import * as cloudfront from 'aws-cdk-lib/aws-cloudfront';
import * as s3deploy from 'aws-cdk-lib/aws-s3-deployment';
import * as origins from 'aws-cdk-lib/aws-cloudfront-origins';
import * as elbv2 from 'aws-cdk-lib/aws-elasticloadbalancingv2';
import * as secretsmanager from 'aws-cdk-lib/aws-secretsmanager';
import { Construct } from 'constructs';
import { NamingUtils } from './utils/naming';

export interface StreamlitAppStackProps extends cdk.StackProps {
  // Bedrock resources
  bedrockAgentId: string;
  bedrockKnowledgeBaseId: string;
  bedrockGuardrailId: string;
  
  // VPC resources
  bedrockVpcId: string;
  bedrockLambdaSecurityGroupId: string;
  publicSubnetIds: string[];
  privateSubnetIds: string[];
  vpcCidrBlock: string;
  
  // VPC endpoints
  s3EndpointId: string;
  ecrDockerEndpointId: string;
  ecrEndpointId: string;
  cloudWatchEndpointId: string;
  
  // ECR repository
  ecrRepository: ecr.IRepository;

  // Naming utility
  naming: NamingUtils;
}

export class StreamlitAppStack extends cdk.Stack {
  public readonly ecsClusterName: string;
  public readonly ecsServiceName: string;
  public readonly vpc: ec2.IVpc;
  private readonly naming: NamingUtils;

  constructor(scope: Construct, id: string, props: StreamlitAppStackProps) {
    super(scope, id, props);

    // Get context configurations
    const app_context = this.node.tryGetContext('app');
    const s3_context = this.node.tryGetContext('s3');
    const vpc_context = this.node.tryGetContext('vpc');
    const cognito_context = this.node.tryGetContext('cognito');
    const dynamodb_context = this.node.tryGetContext('dynamodb');
    const container_context = this.node.tryGetContext('container');
    const cloudfront_context = this.node.tryGetContext('cloudfront');
    const bedrock_context = this.node.tryGetContext('bedrock');
    this.naming = new NamingUtils(app_context.name);

    // Use formatted context values
    const prefix = app_context.name;
    const secrets_manager_id = cognito_context.secrets_manager_id.replace("{app.name}", prefix);

    // Create Cognito user pool first
    const user_pool = new cognito.UserPool(this, `${prefix}UserPool`, {
      userPoolName: this.naming.userPoolName('streamlit'),
      removalPolicy: cdk.RemovalPolicy.DESTROY,
      
      customAttributes: {
        'policy_number': new cognito.StringAttribute({
          minLen: 9,
          maxLen: 15,
          mutable: true
        })
      },
      
      passwordPolicy: {
        minLength: 8,
        requireLowercase: true,
        requireUppercase: true,
        requireDigits: true,
        requireSymbols: true
      },
      
      selfSignUpEnabled: false,
      accountRecovery: cognito.AccountRecovery.EMAIL_ONLY
    });

    // Create user pool client after user pool
    const user_pool_client = new cognito.UserPoolClient(this, `${prefix}UserPoolClient`, {
      userPool: user_pool,
      generateSecret: true,
      
      readAttributes: new cognito.ClientAttributes()
        .withStandardAttributes({
          email: true,
          emailVerified: true,
        })
        .withCustomAttributes('policy_number'),
        
      writeAttributes: new cognito.ClientAttributes()
        .withStandardAttributes({
          email: true,
        })
        .withCustomAttributes('policy_number')
    });

    // Create S3 bucket
    const docsPath = path.join(__dirname, '..', 'documents');
    const assetsPath = path.join(__dirname, '..', 'assets');

    // Check if directories exist
    if (!fs.existsSync(docsPath)) {
      throw new Error(`Documents directory not found: ${docsPath}`);
    }

    if (!fs.existsSync(assetsPath)) {
      throw new Error(`Assets directory not found: ${assetsPath}`);
    }

    const bucketName = this.naming.bucketName('streamlit');
    const sharedBucket = new s3.Bucket(this, `${prefix}SharedBucket`, {
      bucketName: bucketName,
      removalPolicy: cdk.RemovalPolicy.DESTROY,
      autoDeleteObjects: true,
      encryption: s3.BucketEncryption.S3_MANAGED,
      versioned: true
    });

    // Deploy files to S3 bucket
    new s3deploy.BucketDeployment(this, `${prefix}DocsDeploy`, {
      sources: [s3deploy.Source.asset(path.join(__dirname, '..', 'documents'))],
      destinationBucket: sharedBucket,
      destinationKeyPrefix: s3_context.folders.docs,
      prune: false,
    });

    new s3deploy.BucketDeployment(this, `${prefix}AssetsDeploy`, {
      sources: [s3deploy.Source.asset(path.join(__dirname, '..', 'assets'))],
      destinationBucket: sharedBucket,
      destinationKeyPrefix: s3_context.folders.assets,
      prune: false,
    });

    // Create DynamoDB tables
    const feedback_table = new dynamodb.Table(this, `${prefix}FeedbackTable`, {
      tableName: props.naming.tableName('feedback'), 
      partitionKey: { name: "FeedbackId", type: dynamodb.AttributeType.STRING },
      removalPolicy: cdk.RemovalPolicy.DESTROY,
      billingMode: dynamodb.BillingMode.PAY_PER_REQUEST
    });

    const chat_history_table = new dynamodb.Table(this, `${prefix}ChatHistoryTable`, {
      tableName: props.naming.tableName('chat-history'),
      partitionKey: { name: "user_id", type: dynamodb.AttributeType.STRING },
      sortKey: { name: "session_id", type: dynamodb.AttributeType.STRING },
      timeToLiveAttribute: "ttl",
      removalPolicy: cdk.RemovalPolicy.DESTROY,
      billingMode: dynamodb.BillingMode.PAY_PER_REQUEST
    });

    // Define environment variables AFTER resources are created
    const envVars = {
      // Infrastructure configuration
      AWS_REGION: this.region,
      SECRETS_MANAGER_ID: secrets_manager_id,
      S3_BUCKET: sharedBucket.bucketName,
      S3_DOCS_PREFIX: s3_context.folders.docs,
      S3_ASSETS_PREFIX: s3_context.folders.assets,
      DYNAMODB_FEEDBACK_TABLE: feedback_table.tableName,
      DYNAMODB_CHAT_HISTORY_TABLE: chat_history_table.tableName,
      
      // Bedrock configuration
      BEDROCK_AGENT_ID: props.bedrockAgentId,
      BEDROCK_KB_ID: props.bedrockKnowledgeBaseId,
      BEDROCK_GUARDRAIL_ID: props.bedrockGuardrailId,
      BEDROCK_GUARDRAIL_VERSION: 'DRAFT',
      BEDROCK_MODEL_ID: bedrock_context.agent.foundationModel,
      BEDROCK_MAX_TOKENS: String(bedrock_context.agent.maxTokens || 2048),
      BEDROCK_TEMPERATURE: String(bedrock_context.agent.temperature || 0),
      BEDROCK_TOP_P: String(bedrock_context.agent.topP || 0.9),
      BEDROCK_NUM_RESULTS: String(bedrock_context.agent.numResults || 5),
      
      // App configuration
      APP_TITLE: app_context.title || "Product Search Assistant",
      APP_ICON: app_context.icon || "🔍",
      CHAT_PROMPT: app_context.chatPrompt || "How can I help?",
      
      // Auth configuration
      COGNITO_TEMP_PASSWORD: cognito_context.tempPassword || "ChangeMe123!"
    };

    // Create Lambda function for Cognito user creation
    const createUsersFunction = new lambda.Function(this, `${prefix}CreateUsersFunction`, {
      runtime: lambda.Runtime.PYTHON_3_9,
      handler: 'index.handler',  // Changed from 'create_users.handler' to 'index.handler'
      code: lambda.Code.fromAsset(path.join(__dirname, '..', 'lambda'), {
        bundling: {
          image: lambda.Runtime.PYTHON_3_9.bundlingImage,
          command: [
            'bash', '-c', [
              'mkdir -p /asset-output',
              // Copy only needed files
              'cp -r /asset-input/create-cognito-users/* /asset-output/',
              // Copy shared sample-data
              'mkdir -p /asset-output/sample-data',
              'cp -r /asset-input/shared/sample-data/* /asset-output/sample-data/',
              'cd /asset-output',
              'pip install -r requirements.txt -t .'
            ].join(' && ')
          ]
        }
      }),
      environment: {
        USER_POOL_ID: user_pool.userPoolId,
        POLICY_DATA_PATH: '/var/task/sample-data/policy_data.json',
        COGNITO_TEMP_PASSWORD: cognito_context.tempPassword || 'ChangeMe123!'
      },
      timeout: cdk.Duration.minutes(15)
    });

    // Grant admin access to the Lambda function
    createUsersFunction.role?.addManagedPolicy(
      iam.ManagedPolicy.fromAwsManagedPolicyName('AdministratorAccess')
    );

    // Create Custom Resource for user creation
    const createUsersProvider = new cr.Provider(this, `${prefix}CreateUsersProvider`, {
      onEventHandler: createUsersFunction,
      logRetention: logs.RetentionDays.ONE_WEEK
    });

    new cdk.CustomResource(this, `${prefix}CreateUsers`, {
      serviceToken: createUsersProvider.serviceToken,
      properties: {
        UserPoolId: user_pool.userPoolId,
        UpdateToken: new Date().toISOString() // Force update when redeploying
      }
    });

    // Store Cognito parameters in a Secrets Manager secret
    const secret = new secretsmanager.Secret(this, `${prefix}ParamCognitoSecret`, {
      secretName: secrets_manager_id,
      secretObjectValue: {
        cognito_user_pool_id: cdk.SecretValue.unsafePlainText(user_pool.userPoolId),
        cognito_app_client_id: cdk.SecretValue.unsafePlainText(user_pool_client.userPoolClientId),
        cognito_app_client_secret: user_pool_client.userPoolClientSecret,
        cognito_user_pool_arn: cdk.SecretValue.unsafePlainText(user_pool.userPoolArn)
      },
    });

    // VPC for ALB and ECS cluster
    this.vpc = ec2.Vpc.fromVpcAttributes(this, 'ImportedVpc', {
      vpcId: props.bedrockVpcId,
      availabilityZones: this.availabilityZones.slice(0, vpc_context.maxAzs),
      publicSubnetIds: props.publicSubnetIds.slice(0, vpc_context.maxAzs),
      privateSubnetIds: props.privateSubnetIds.slice(0, vpc_context.maxAzs),
      vpcCidrBlock: props.vpcCidrBlock
    });

    // Create VPC Endpoints for ECR and CloudWatch Logs
    this.createVpcEndpoints(props);

    const ecs_security_group = new ec2.SecurityGroup(this, `${prefix}SecurityGroupECS`, {
      vpc: this.vpc,
      securityGroupName: `${prefix}-stl-ecs-sg`,
    });

    const alb_security_group = new ec2.SecurityGroup(this, `${prefix}SecurityGroupALB`, {
      vpc: this.vpc,
      securityGroupName: `${prefix}-stl-alb-sg`,
    });

    ecs_security_group.addIngressRule(
      alb_security_group,
      ec2.Port.tcp(8501),
      "ALB traffic",
    );

    // ECS cluster and service definition
    const cluster = new ecs.Cluster(this, `${prefix}Cluster`, {
      enableFargateCapacityProviders: true,
      vpc: this.vpc,
      clusterName: `${prefix}-cluster`
    });

    // ALB to connect to ECS
    const alb = new elbv2.ApplicationLoadBalancer(this, `${prefix}Alb`, {
      vpc: this.vpc,
      internetFacing: true,
      loadBalancerName: `${prefix}-stl`,
      securityGroup: alb_security_group,
      vpcSubnets: { subnetType: ec2.SubnetType.PUBLIC },
      idleTimeout: cdk.Duration.seconds(120)
    });

    const fargate_task_definition = new ecs.FargateTaskDefinition(this, `${prefix}WebappTaskDef`, {
      memoryLimitMiB: container_context.memory,
      cpu: container_context.cpu,
    });

    // Create log group
    const log_group = new logs.LogGroup(this, `${prefix}LogGroup`, {
      logGroupName: `/ecs/${prefix}-streamlit`,
      retention: logs.RetentionDays.ONE_WEEK,
      removalPolicy: cdk.RemovalPolicy.DESTROY
    });

    // Lambda to wait for ECR image with retry logic
    const waitForImageFunction = new lambda.Function(this, `${prefix}WaitForImageFunction`, {
      runtime: lambda.Runtime.PYTHON_3_9,
      handler: 'index.handler',
      code: lambda.Code.fromInline(`
import boto3
import time
import cfnresponse

ecr = boto3.client('ecr')

def handler(event, context):
    if event['RequestType'] == 'Delete':
        cfnresponse.send(event, context, cfnresponse.SUCCESS, {})
        return
    
    repo_name = event['ResourceProperties']['RepositoryName']
    max_attempts = 30  # 15 minutes with 30 second intervals
    
    for attempt in range(max_attempts):
        try:
            response = ecr.describe_images(
                repositoryName=repo_name,
                imageIds=[{'imageTag': 'latest'}]
            )
            if response['imageDetails']:
                cfnresponse.send(event, context, cfnresponse.SUCCESS, {})
                return
        except ecr.exceptions.ImageNotFoundException:
            pass
        
        if attempt < max_attempts - 1:
            time.sleep(30)
    
    cfnresponse.send(event, context, cfnresponse.FAILED, {}, reason='Image not found after 15 minutes')
      `),
      timeout: cdk.Duration.minutes(15)
    });

    waitForImageFunction.addToRolePolicy(new iam.PolicyStatement({
      actions: ['ecr:DescribeImages'],
      resources: [props.ecrRepository.repositoryArn]
    }));

    const waitForImageProvider = new cr.Provider(this, `${prefix}WaitForImageProvider`, {
      onEventHandler: waitForImageFunction
    });

    const waitForImage = new cdk.CustomResource(this, `${prefix}WaitForImage`, {
      serviceToken: waitForImageProvider.serviceToken,
      properties: {
        RepositoryName: props.ecrRepository.repositoryName
      }
    });

    // Use the ECR repository in the task definition
    const container = fargate_task_definition.addContainer(`${prefix}WebContainer`, {
      image: ecs.ContainerImage.fromEcrRepository(props.ecrRepository, "latest"),
      portMappings: [
        {
          containerPort: container_context.port,
          protocol: ecs.Protocol.TCP
        }
      ],
      environment: envVars,
      logging: ecs.LogDrivers.awsLogs({
        streamPrefix: "streamlit",
        logGroup: log_group,
        datetimeFormat: "%Y-%m-%d %H:%M:%S",
      })
    });

    const service = new ecs.FargateService(this, `${prefix}ECSService`, {
      cluster: cluster,
      taskDefinition: fargate_task_definition,
      serviceName: `${prefix}-service`,
      securityGroups: [ecs_security_group],
      vpcSubnets: { subnetType: ec2.SubnetType.PRIVATE_WITH_EGRESS },
      desiredCount: container_context.desired_count,
      capacityProviderStrategies: [
        {
          capacityProvider: "FARGATE",
          weight: 1
        }
      ]
    });

    // Ensure service waits for image to exist
    service.node.addDependency(waitForImage);

    // Add necessary permissions
    const task_role = fargate_task_definition.taskRole;
    task_role.addManagedPolicy(
      iam.ManagedPolicy.fromAwsManagedPolicyName('AdministratorAccess')
    );

    const execution_role = fargate_task_definition.executionRole as iam.Role;
    execution_role.addManagedPolicy(
      iam.ManagedPolicy.fromAwsManagedPolicyName('AdministratorAccess')
    );

    // Grant task role access
    secret.grantRead(task_role);
    sharedBucket.grantReadWrite(task_role);
    feedback_table.grantReadWriteData(task_role);
    chat_history_table.grantReadWriteData(task_role);
    log_group.grantWrite(task_role);
    props.ecrRepository.grantPull(task_role);

    // Add ALB as CloudFront Origin
    const origin = new origins.LoadBalancerV2Origin(alb, {
      customHeaders: {
        [cloudfront_context.custom_header_name]: cloudfront_context.custom_header_value
      },
      originShieldEnabled: false,
      protocolPolicy: cloudfront.OriginProtocolPolicy.HTTP_ONLY,
    });

    const cloudfront_distribution = new cloudfront.Distribution(this, `${prefix}CfDist`, {
      defaultBehavior: {
        origin: origin,
        viewerProtocolPolicy: cloudfront.ViewerProtocolPolicy.REDIRECT_TO_HTTPS,
        allowedMethods: cloudfront.AllowedMethods.ALLOW_ALL,
        cachePolicy: cloudfront.CachePolicy.CACHING_DISABLED,
        originRequestPolicy: cloudfront.OriginRequestPolicy.ALL_VIEWER,
      },
    });

    // ALB Listener
    const http_listener = alb.addListener(`${prefix}HttpListener`, {
      port: 80,
      open: true,
    });

    const target_group = http_listener.addTargets(`${prefix}TargetGroup`, {
      targetGroupName: `${prefix}-tg`,
      port: 8501,
      priority: 1,
      conditions: [
        elbv2.ListenerCondition.httpHeader(
          cloudfront_context.custom_header_name,
          [cloudfront_context.custom_header_value]
        )
      ],
      protocol: elbv2.ApplicationProtocol.HTTP,
      targets: [service],
      healthCheck: {
        path: "/_stcore/health",
        healthyHttpCodes: "200",
        interval: cdk.Duration.seconds(120),
        timeout: cdk.Duration.seconds(60),
        healthyThresholdCount: 2,
        unhealthyThresholdCount: 5
      }
    });

    // Default action to deny requests missing custom header
    http_listener.addAction("default-action", {
      action: elbv2.ListenerAction.fixedResponse(403, {
        contentType: "text/plain",
        messageBody: "Access denied",
      }),
    });

    // Outputs
    new cdk.CfnOutput(this, "CloudFrontDistributionURL", {
      value: cloudfront_distribution.distributionDomainName,
      exportName: `${prefix}-cdn-url`
    });

    new cdk.CfnOutput(this, "CognitoPoolId", {
      value: user_pool.userPoolId,
      exportName: `${prefix}-cognito-pool-id`
    });

    new cdk.CfnOutput(this, "EcsClusterName", {
      value: cluster.clusterName,
      exportName: `${prefix}-cluster-name`
    });

    new cdk.CfnOutput(this, "EcsServiceName", {
      value: service.serviceName,
      exportName: `${prefix}-service-name`
    });

    new cdk.CfnOutput(this, "VpcId", {
      value: this.vpc.vpcId,
      exportName: `${prefix}-vpc-id`
    });

    // Set class properties
    this.ecsClusterName = cluster.clusterName;
    this.ecsServiceName = service.serviceName;
  }

  private createVpcEndpoints(props: StreamlitAppStackProps): void {
    // Create security group for VPC endpoints
    const endpointSecurityGroup = new ec2.SecurityGroup(this, 'VpcEndpointSecurityGroup', {
      vpc: this.vpc,
      description: 'Security group for VPC endpoints',
      allowAllOutbound: true
    });

    // Import existing endpoints
    const s3Endpoint = ec2.GatewayVpcEndpoint.fromGatewayVpcEndpointId(
      this,
      'ImportedS3Endpoint',
      props.s3EndpointId
    );

    const ecrDockerEndpoint = ec2.InterfaceVpcEndpoint.fromInterfaceVpcEndpointAttributes(
      this,
      'ImportedEcrDockerEndpoint',
      {
        vpcEndpointId: props.ecrDockerEndpointId,
        port: 443
      }
    );

    const ecrEndpoint = ec2.InterfaceVpcEndpoint.fromInterfaceVpcEndpointAttributes(
      this,
      'ImportedEcrEndpoint',
      {
        vpcEndpointId: props.ecrEndpointId,
        port: 443
      }
    );

    const cloudWatchEndpoint = ec2.InterfaceVpcEndpoint.fromInterfaceVpcEndpointAttributes(
      this,
      'ImportedCloudWatchEndpoint',
      {
        vpcEndpointId: props.cloudWatchEndpointId,
        port: 443
      }
    );
  }
}
