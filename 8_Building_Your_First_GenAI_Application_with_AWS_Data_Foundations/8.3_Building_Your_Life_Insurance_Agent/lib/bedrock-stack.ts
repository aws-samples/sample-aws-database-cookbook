// lib/bedrock-stack.ts

import * as fs from 'fs';
import * as path from 'path';
import * as cdk from 'aws-cdk-lib';
import * as s3 from 'aws-cdk-lib/aws-s3';
import * as rds from 'aws-cdk-lib/aws-rds';
import * as ec2 from 'aws-cdk-lib/aws-ec2';
import * as ssm from 'aws-cdk-lib/aws-ssm';
import * as iam from 'aws-cdk-lib/aws-iam';
import * as logs from 'aws-cdk-lib/aws-logs';
import * as lambda from 'aws-cdk-lib/aws-lambda';
import * as cr from 'aws-cdk-lib/custom-resources';
import * as s3deploy from 'aws-cdk-lib/aws-s3-deployment';
import { 
  AgentDefinitionProps,
  AgentDefinitionBuilder,
  AgentActionGroup,
  BedrockAgentBlueprintsConstruct,
} from '@aws/agents-for-amazon-bedrock-blueprints';
import { Stack } from 'aws-cdk-lib';
import { Construct } from 'constructs';
import { NamingUtils } from './utils/naming';
import { aws_bedrock as bedrock } from 'aws-cdk-lib';
import { NodejsFunction } from 'aws-cdk-lib/aws-lambda-nodejs';

export interface BedrockStackProps extends cdk.StackProps {
  naming: NamingUtils;
}

export class BedrockStack extends cdk.Stack {
  private readonly agent: BedrockAgentBlueprintsConstruct;
  private readonly lambdaSecurityGroup: ec2.SecurityGroup;
  private readonly policyCluster: rds.DatabaseCluster;
  private readonly kbCluster: rds.DatabaseCluster;
  private readonly agentBucket: s3.Bucket;
  private readonly naming: NamingUtils;
  private readonly vpc: ec2.Vpc;

  private knowledgeBase: bedrock.CfnKnowledgeBase;
  private knowledgeBaseDataSource: bedrock.CfnDataSource;
  private sampleDataLoader: cdk.CustomResource;
  private guardrail: bedrock.CfnGuardrail;
  private s3Endpoint: ec2.GatewayVpcEndpoint;
  private ecrDockerEndpoint: ec2.InterfaceVpcEndpoint;
  private ecrEndpoint: ec2.InterfaceVpcEndpoint;
  private cloudWatchEndpoint: ec2.InterfaceVpcEndpoint;
  private pgLayer?: lambda.LayerVersion;

  private readonly schemas: {
    getPolicyDetails: string;
    makePayment: string;
    updateAddress: string;
    updateBeneficiary: string;
  };

  private readonly instructions: {
    agent: string;
    knowledgeBase: string;
  };

  constructor(scope: Construct, id: string, props: BedrockStackProps) {
    super(scope, id, props);
    this.naming = props.naming;

    // Get context values
    const app_context = this.node.tryGetContext('app');
    const vpc_context = this.node.tryGetContext('vpc');
    const bedrock_context = this.node.tryGetContext('bedrock');
    const lambda_context = this.node.tryGetContext('lambda');
    const db_context = this.node.tryGetContext('databases');

    const prefix = app_context.name;
    const kbSchemaName = db_context.knowledge.schema;
    const kbMainTableName = db_context.knowledge.tables.bedrock_kb;
    this.replacePrefixInContext(db_context, prefix);

    // Log context values
    console.log('Context Values:');
    console.log('App Context:', JSON.stringify(app_context, null, 2));
    console.log('Database Context:', JSON.stringify(db_context, null, 2));

    // Create VPC
    this.vpc = new ec2.Vpc(this, 'VPC', {
      maxAzs: vpc_context.maxAzs,
      natGateways: vpc_context.natGateways,
      subnetConfiguration: [
        {
          cidrMask: vpc_context.subnetConfiguration.public.cidrMask,
          name: vpc_context.subnetConfiguration.public.name,
          subnetType: ec2.SubnetType.PUBLIC,
        },
        {
          cidrMask: vpc_context.subnetConfiguration.private.cidrMask,
          name: vpc_context.subnetConfiguration.private.name,
          subnetType: ec2.SubnetType.PRIVATE_WITH_NAT,
        },
        {
          cidrMask: vpc_context.subnetConfiguration.isolated.cidrMask,
          name: vpc_context.subnetConfiguration.isolated.name,
          subnetType: ec2.SubnetType.PRIVATE_ISOLATED,
        }
      ],
      enableDnsHostnames: true,
      enableDnsSupport: true,
    });

    // Add tags to VPC
    cdk.Tags.of(this.vpc).add('CreationSource', 'aws-database-cookbook-v2025.8');

    // Create Security Group for Lambda functions
    this.lambdaSecurityGroup = new ec2.SecurityGroup(this, 'LambdaSecurityGroup', {
      securityGroupName: this.naming.securityGroupName('lambda'),
      vpc: this.vpc,
      description: 'Security group for Lambda functions',
      allowAllOutbound: true
    });

    // Add VPC Endpoints
    this.addVpcEndpoints();

    const dbSecurityGroup = new ec2.SecurityGroup(this, 'DBSecurityGroup', {
      vpc: this.vpc,
      allowAllOutbound: true,
      description: 'Security group for RDS database'
    });

    dbSecurityGroup.addIngressRule(
      this.lambdaSecurityGroup,
      ec2.Port.tcp(5432),
      'Allow Postgres access from Lambda functions'
    );

    // Create Policy Database Cluster
    this.policyCluster = new rds.DatabaseCluster(this, 'PolicyCluster', {
      engine: rds.DatabaseClusterEngine.auroraPostgres({
        version: rds.AuroraPostgresEngineVersion.VER_15_8
      }),
      instanceProps: {
        instanceType: ec2.InstanceType.of(ec2.InstanceClass.T3, ec2.InstanceSize.MEDIUM),
        vpcSubnets: { subnetType: ec2.SubnetType.PRIVATE_WITH_NAT },
        vpc: this.vpc,
      },
      instances: db_context.policy.instances,
      clusterIdentifier: db_context.policy.cluster.identifier,
      defaultDatabaseName:db_context.policy.cluster.name,
      parameterGroup: new rds.ParameterGroup(this, 'PolicyDBParameterGroup', {
        engine: rds.DatabaseClusterEngine.auroraPostgres({
          version: rds.AuroraPostgresEngineVersion.VER_15_8
        })
      }),
      securityGroups: [dbSecurityGroup],
      removalPolicy: cdk.RemovalPolicy.DESTROY,
      deletionProtection: false
    });

    // Add tags to Policy Database Cluster
    cdk.Tags.of(this.policyCluster).add('CreationSource', 'aws-database-cookbook-v2025.8');

    // Create Knowledge Base Cluster
    const kbSecurityGroup = new ec2.SecurityGroup(this, 'KBSecurityGroup', {
      vpc: this.vpc,
      description: 'Security group for Knowledge Base database',
      allowAllOutbound: true,
      securityGroupName: this.naming.securityGroupName('kb')
    });

    // Allow inbound from Lambda security group
    kbSecurityGroup.addIngressRule(
      this.lambdaSecurityGroup,
      ec2.Port.tcp(5432),
      'Allow Postgres access from Lambda functions'
    );

    this.kbCluster = new rds.DatabaseCluster(this, 'KnowledgeBaseCluster', {
      engine: rds.DatabaseClusterEngine.auroraPostgres({
        version: rds.AuroraPostgresEngineVersion.VER_15_8
      }),
      instanceProps: {
        instanceType: ec2.InstanceType.of(ec2.InstanceClass.R6G, ec2.InstanceSize.LARGE),
        vpcSubnets: { subnetType: ec2.SubnetType.PRIVATE_WITH_NAT },
        vpc: this.vpc,
        securityGroups: [kbSecurityGroup]
      },
      instances: db_context.knowledge.instances,
      clusterIdentifier: db_context.knowledge.cluster.identifier,
      defaultDatabaseName: db_context.knowledge.cluster.name,
      parameterGroup: new rds.ParameterGroup(this, 'KBParameterGroup', {
        engine: rds.DatabaseClusterEngine.auroraPostgres({
          version: rds.AuroraPostgresEngineVersion.VER_15_8
        })
      }),
      removalPolicy: cdk.RemovalPolicy.DESTROY,
      deletionProtection: false,
      enableDataApi: true
    });

    // Add tags to Knowledge Base Cluster
    cdk.Tags.of(this.kbCluster).add('CreationSource', 'aws-database-cookbook-v2025.8');

    // Create S3 bucket for agent
    this.agentBucket = this.createAgentBucket();

    // Create IAM role for Bedrock Agent
    const agentRole = this.createAgentRole(this.agentBucket);

    // Create custom resources for database initialization
    const { policyDBInit, kbExtensionInit, kbDBInit, clusterWaiter } = this.createCustomResources(this.agentBucket, agentRole);

    // Create Bedrock Guardrail
    this.guardrail = this.createBedrockGuardrail();

    // Create Bedrock Knowledge Base
    this.knowledgeBase = this.createKnowledgeBase(this.agentBucket, agentRole);
    this.deployKnowledgeBaseDocs();

    // Load schemas
    this.schemas = {
      getPolicyDetails: fs.readFileSync(path.join(__dirname, 'schemas/get-policy-details.yaml'), 'utf8'),
      makePayment: fs.readFileSync(path.join(__dirname, 'schemas/make-payment.yaml'), 'utf8'),
      updateAddress: fs.readFileSync(path.join(__dirname, 'schemas/update-address.yaml'), 'utf8'),
      updateBeneficiary: fs.readFileSync(path.join(__dirname, 'schemas/update-beneficiary.yaml'), 'utf8'),
    };

    // Load instructions
    this.instructions = {
      agent: fs.readFileSync(path.join(__dirname, 'instructions/agent.md'), 'utf8'),
      knowledgeBase: fs.readFileSync(path.join(__dirname, 'instructions/knowledge-base.md'), 'utf8'),
    };

    // Create action groups for Bedrock Agent
    const actionGroups = [
      this.createActionGroup('get-policy-details', this.schemas.getPolicyDetails),
      this.createActionGroup('make-payment', this.schemas.makePayment),
      this.createActionGroup('update-address', this.schemas.updateAddress),
      this.createActionGroup('update-beneficiary', this.schemas.updateBeneficiary)
    ];

    // Create Bedrock Agent
    this.agent = this.createBedrockAgent(actionGroups, agentRole);

    // Create the Knowledge Base association
    const kbAssociation = this.createKnowledgeBaseAssociation(this.agent.agent.ref, this.knowledgeBase.ref);

    // Add dependencies explicitly
    kbAssociation.node.addDependency(this.agent);
    kbAssociation.node.addDependency(this.knowledgeBase);

    // Create Sample Data Loader
    this.sampleDataLoader = this.createSampleDataLoader();

    // Add dependencies
    this.knowledgeBase.node.addDependency(clusterWaiter);
    this.knowledgeBase.node.addDependency(kbDBInit);
    this.knowledgeBase.node.addDependency(this.kbCluster);
    this.sampleDataLoader.node.addDependency(this.knowledgeBase);
    this.sampleDataLoader.node.addDependency(kbDBInit);
    this.sampleDataLoader.node.addDependency(policyDBInit);

    // Export necessary values for cross-stack references
    this.exportValues();
  }

  private replacePrefixInContext(obj: any, prefix: string) {
    for (const key in obj) {
      if (typeof obj[key] === 'string') {
        obj[key] = obj[key].replace('{prefix}', prefix);
      } else if (typeof obj[key] === 'object') {
        this.replacePrefixInContext(obj[key], prefix);
      }
    }
  }

  private addVpcEndpoints(): void {
    // Add Secrets Manager VPC endpoint
    new ec2.InterfaceVpcEndpoint(this, 'SecretsManagerEndpoint', {
      vpc: this.vpc,
      service: ec2.InterfaceVpcEndpointAwsService.SECRETS_MANAGER,
      subnets: { subnetType: ec2.SubnetType.PRIVATE_WITH_NAT },
      privateDnsEnabled: true
    });

    // Add RDS VPC endpoint
    new ec2.InterfaceVpcEndpoint(this, 'RDSEndpoint', {
      vpc: this.vpc,
      service: ec2.InterfaceVpcEndpointAwsService.RDS,
      subnets: { subnetType: ec2.SubnetType.PRIVATE_WITH_NAT },
      privateDnsEnabled: true
    });

    // Add RDS Data API endpoint
    new ec2.InterfaceVpcEndpoint(this, 'RDSDataEndpoint', {
      vpc: this.vpc,
      service: ec2.InterfaceVpcEndpointAwsService.RDS_DATA,
      subnets: { subnetType: ec2.SubnetType.PRIVATE_WITH_NAT },
      privateDnsEnabled: true
    });

    new ec2.InterfaceVpcEndpoint(this, 'BedrockEndpoint', {
      vpc: this.vpc,
      service: ec2.InterfaceVpcEndpointAwsService.BEDROCK,
      subnets: { subnetType: ec2.SubnetType.PRIVATE_WITH_NAT },
      privateDnsEnabled: true
    });

    new ec2.InterfaceVpcEndpoint(this, 'BedrockRuntimeEndpoint', {
      vpc: this.vpc,
      service: ec2.InterfaceVpcEndpointAwsService.BEDROCK_RUNTIME,
      subnets: { subnetType: ec2.SubnetType.PRIVATE_WITH_NAT },
      privateDnsEnabled: true
    });

    // Add S3 Gateway endpoint - assign to class property
    this.s3Endpoint = this.vpc.addGatewayEndpoint('S3Endpoint', {
      service: ec2.GatewayVpcEndpointAwsService.S3
    });

    // Add ECR Docker endpoint - assign to class property
    this.ecrDockerEndpoint = new ec2.InterfaceVpcEndpoint(this, 'EcrDockerEndpoint', {
      vpc: this.vpc,
      service: ec2.InterfaceVpcEndpointAwsService.ECR_DOCKER,
      subnets: { subnetType: ec2.SubnetType.PRIVATE_WITH_NAT },
      privateDnsEnabled: true
    });

    // Add ECR endpoint - assign to class property
    this.ecrEndpoint = new ec2.InterfaceVpcEndpoint(this, 'EcrEndpoint', {
      vpc: this.vpc,
      service: ec2.InterfaceVpcEndpointAwsService.ECR,
      subnets: { subnetType: ec2.SubnetType.PRIVATE_WITH_NAT },
      privateDnsEnabled: true
    });

    // Add CloudWatch Logs endpoint - assign to class property
    this.cloudWatchEndpoint = new ec2.InterfaceVpcEndpoint(this, 'CloudWatchLogsEndpoint', {
      vpc: this.vpc,
      service: ec2.InterfaceVpcEndpointAwsService.CLOUDWATCH_LOGS,
      subnets: { subnetType: ec2.SubnetType.PRIVATE_WITH_NAT },
      privateDnsEnabled: true
    });

    new ec2.InterfaceVpcEndpoint(this, 'CloudFormationEndpoint', {
      vpc: this.vpc,
      service: ec2.InterfaceVpcEndpointAwsService.CLOUDFORMATION,
      open: true
    });
  }

  private createAgentBucket(): s3.Bucket {
    const bucket = new s3.Bucket(this, 'AgentBucket', {
      bucketName: this.naming.bucketName('bedrock'),
      versioned: true,
      encryption: s3.BucketEncryption.S3_MANAGED,
      blockPublicAccess: s3.BlockPublicAccess.BLOCK_ALL,
      removalPolicy: cdk.RemovalPolicy.DESTROY,
      autoDeleteObjects: true
    });

    bucket.addToResourcePolicy(new iam.PolicyStatement({
      effect: iam.Effect.ALLOW,
      principals: [new iam.ServicePrincipal('bedrock.amazonaws.com')],
      actions: [
        's3:GetObject',
        's3:ListBucket'
      ],
      resources: [
        bucket.bucketArn,
        `${bucket.bucketArn}/*`
      ]
    }));

    return bucket;
  }

  private createAgentRole(bucket: s3.Bucket): iam.Role {
    const role = new iam.Role(this, 'BedrockAgentRole', {
      assumedBy: new iam.ServicePrincipal('bedrock.amazonaws.com'),
      managedPolicies: [
        iam.ManagedPolicy.fromAwsManagedPolicyName('AdministratorAccess')
      ]
    });

    return role;
  }

  private createCustomResources(agentBucket: s3.Bucket, agentRole: iam.Role) {
    const lambda_context = this.node.tryGetContext('lambda');

    // Create RDS cluster waiter
    const clusterWaiter = new cr.Provider(this, 'ClusterWaiterProvider', {
      onEventHandler: new NodejsFunction(this, 'ClusterWaiterFunction', {
        entry: path.join(__dirname, '../lambda/cluster-waiter/index.ts'),
        handler: 'handler',
        runtime: lambda.Runtime.NODEJS_18_X,
        timeout: cdk.Duration.minutes(15),
        vpc: this.vpc,
        vpcSubnets: {
          subnetType: ec2.SubnetType.PRIVATE_WITH_NAT
        },
        securityGroups: [this.lambdaSecurityGroup],
      }),
      logRetention: logs.RetentionDays.ONE_DAY
    });

    // Grant necessary permissions to the waiter
    clusterWaiter.onEventHandler.addToRolePolicy(new iam.PolicyStatement({
      effect: iam.Effect.ALLOW,
      actions: [
        'rds:DescribeDBClusters',
        'rds:DescribeDBInstances'
      ],
      resources: ['*']
    }));

    // Create database initializers
    const policyDBInit = this.createPolicyDBInitializer();
    const kbExtensionInit = this.createKBExtensionInitializer();
    const kbDBInit = this.createKBDBInitializer();

    // Set up dependencies
    policyDBInit.node.addDependency(clusterWaiter);
    kbDBInit.node.addDependency(kbExtensionInit);
    kbDBInit.node.addDependency(this.kbCluster);
    kbExtensionInit.node.addDependency(this.kbCluster);
    policyDBInit.node.addDependency(this.policyCluster);

    return {
      policyDBInit,
      kbExtensionInit,
      kbDBInit,
      clusterWaiter: new cdk.CustomResource(this, 'ClusterWaiter', {
        serviceToken: clusterWaiter.serviceToken,
        properties: {
          policyClusterArn: this.policyCluster.clusterArn, 
          clusterArn: this.kbCluster.clusterArn,
          timestamp: Date.now().toString()
        }
      })
    };
  }

  private createSampleDataLoader(): cdk.CustomResource {
      const db_context = this.node.tryGetContext('databases');

      const loadDataFunction = new lambda.Function(this, 'LoadSampleDataFunction', {
          runtime: lambda.Runtime.PYTHON_3_10,
          handler: 'index.handler',
          architecture: lambda.Architecture.ARM_64,
          code: lambda.Code.fromAsset(path.join(__dirname, '..', 'lambda'), {
              bundling: {
                  image: lambda.Runtime.PYTHON_3_10.bundlingImage,
                  command: [
                      'bash', '-c', [
                          'mkdir -p /asset-output',
                          // Copy the load-sample-data Lambda function
                          'cp -r /asset-input/load-sample-data/* /asset-output/',
                          // Create shared/sample-data directory
                          'mkdir -p /asset-output/shared/sample-data',
                          // Copy sample data files
                          'cp -r /asset-input/shared/sample-data/* /asset-output/shared/sample-data/',
                          // Install dependencies
                          'cd /asset-output',
                          'pip install -r requirements.txt -t .',
                          // List contents for verification
                          'echo "Contents of /asset-output:"',
                          'ls -la /asset-output',
                          'echo "Contents of /asset-output/shared/sample-data:"',
                          'ls -la /asset-output/shared/sample-data'
                      ].join(' && ')
                  ]
              }
          }),
          vpc: this.vpc,
          vpcSubnets: { subnetType: ec2.SubnetType.PRIVATE_WITH_NAT },
          securityGroups: [this.lambdaSecurityGroup],
          timeout: cdk.Duration.minutes(15),
          memorySize: 512, // Added explicit memory setting
          environment: {
              POLICY_CLUSTER_ENDPOINT: this.policyCluster.clusterEndpoint.hostname,
              KB_CLUSTER_ENDPOINT: this.kbCluster.clusterEndpoint.hostname,
              POLICY_SECRET_ARN: this.policyCluster.secret?.secretArn || '',
              KB_SECRET_ARN: this.kbCluster.secret?.secretArn || '',
              POLICY_DB_NAME: db_context.policy.cluster.name,
              KB_DB_NAME: db_context.knowledge.cluster.name,
              POLICY_SCHEMA: db_context.policy.schema,
              KB_SCHEMA_NAME: db_context.knowledge.schema,
              KB_MAIN_TABLE_NAME: db_context.knowledge.tables.bedrock_kb,
              POLICIES_TABLE: db_context.policy.tables.policies,
              PREMIUMS_TABLE: db_context.policy.tables.premiums,
              ADDRESSES_TABLE: db_context.policy.tables.addresses,
              BENEFICIARIES_TABLE: db_context.policy.tables.beneficiaries,
              PAYMENT_HISTORY_TABLE: db_context.policy.tables.payment_history,
              PAYMENT_METHODS_TABLE: db_context.policy.tables.payment_methods,
              KNOWLEDGE_BASE_ID: this.knowledgeBase.ref,
              DATA_SOURCE_ID: this.knowledgeBaseDataSource.attrDataSourceId
          },
          description: 'Lambda function to load sample data into policy and knowledge base databases'
      });

      // Grant necessary permissions
      loadDataFunction.role?.addManagedPolicy(
          iam.ManagedPolicy.fromAwsManagedPolicyName('AdministratorAccess')
      );

      // Add specific permissions for RDS
      loadDataFunction.addToRolePolicy(new iam.PolicyStatement({
          effect: iam.Effect.ALLOW,
          actions: [
              'rds:*',
              'secretsmanager:GetSecretValue',
              'bedrock:*'
          ],
          resources: ['*']
      }));

      // Create provider with proper configuration
      const provider = new cr.Provider(this, 'SampleDataLoaderProvider', {
          onEventHandler: loadDataFunction,
          logRetention: logs.RetentionDays.ONE_DAY,
      });

      // Create the custom resource with proper configuration
      const resource = new cdk.CustomResource(this, 'SampleDataLoader', {
          serviceToken: provider.serviceToken,
          properties: {
              timestamp: Date.now(),
              policyClusterArn: this.policyCluster.clusterArn,
              kbClusterArn: this.kbCluster.clusterArn,
              knowledgeBaseId: this.knowledgeBase.ref,
              dataSourceId: this.knowledgeBaseDataSource.attrDataSourceId
          },
          removalPolicy: cdk.RemovalPolicy.DESTROY
      });

      // Add explicit dependencies
      resource.node.addDependency(this.policyCluster);
      resource.node.addDependency(this.kbCluster);
      resource.node.addDependency(this.knowledgeBase);
      resource.node.addDependency(this.knowledgeBaseDataSource);

      // Grant additional permissions to the provider's role
      provider.onEventHandler.role?.addManagedPolicy(
          iam.ManagedPolicy.fromAwsManagedPolicyName('service-role/AWSLambdaVPCAccessExecutionRole')
      );

      return resource;
  }

  private createPolicyDBInitializer(): cdk.CustomResource {
      const db_context = this.node.tryGetContext('databases').policy;

      console.log('Policy DB Context:', {
          schemaName: db_context.schema,
          databaseName: db_context.cluster.name,
          tables: db_context.tables
      });

      const initPolicyDBFunction = new lambda.Function(this, 'InitializePolicyDBFunction', {
          functionName: this.naming.functionName('policy-db-init'),
          runtime: lambda.Runtime.PYTHON_3_10,
          handler: 'index.handler',
          architecture: lambda.Architecture.ARM_64,
          code: lambda.Code.fromAsset(path.join(__dirname, '../lambda/initialize-db'), {
              bundling: {
                  image: lambda.Runtime.PYTHON_3_10.bundlingImage,
                  command: [
                      'bash', '-c', [
                          'mkdir -p /asset-output',
                          'cp -r /asset-input/* /asset-output/',
                          'mkdir -p /asset-output/sql',
                          'cp -r /asset-input/sql/* /asset-output/sql/',
                          'cd /asset-output',
                          'pip install -r requirements.txt -t .',
                          'ls -la /asset-output',
                          'ls -la /asset-output/sql'
                      ].join(' && ')
                  ]
              }
          }),
          vpc: this.vpc,
          vpcSubnets: { subnetType: ec2.SubnetType.PRIVATE_WITH_NAT },
          securityGroups: [this.lambdaSecurityGroup],
          timeout: cdk.Duration.minutes(15),
          environment: {
              CLUSTER_ENDPOINT: this.policyCluster.clusterEndpoint.hostname,
              SECRET_ARN: this.policyCluster.secret?.secretArn || '',
              DB_NAME: db_context.cluster.name,
              SQL_DIR: 'sql',
              SQL_FILE: 'policy_db_tables.sql',
              POLICY_SCHEMA: db_context.schema,
              POLICIES_TABLE: db_context.tables.policies,
              PREMIUMS_TABLE: db_context.tables.premiums,
              ADDRESSES_TABLE: db_context.tables.addresses,
              BENEFICIARIES_TABLE: db_context.tables.beneficiaries,
              PAYMENT_HISTORY_TABLE: db_context.tables.payment_history,
              PAYMENT_METHODS_TABLE: db_context.tables.payment_methods
          }
      });

      // Grant admin permissions for development
      initPolicyDBFunction.role?.addManagedPolicy(
          iam.ManagedPolicy.fromAwsManagedPolicyName('AdministratorAccess')
      );

      // Create the custom resource
      const customResource = new cdk.CustomResource(this, 'PolicyDBInitializer', {
          serviceToken: new cr.Provider(this, 'PolicyDBInitProvider', {
              onEventHandler: initPolicyDBFunction,
              logRetention: logs.RetentionDays.ONE_DAY
          }).serviceToken,
          properties: {
              timestamp: Date.now(),
              clusterArn: this.policyCluster.clusterArn,
              schemaName: db_context.schema
          }
      });

      return customResource;
  }

  private createKBExtensionInitializer(): cdk.CustomResource {
    const db_context = this.node.tryGetContext('databases').knowledge;

    console.log('KB Extension Initializer Context:');
    console.log('Database Context:', JSON.stringify(db_context, null, 2));
    console.log('DB Name:', db_context.cluster.name);

    const createKBExtension = new lambda.Function(this, 'CreateKBExtension', {
      runtime: lambda.Runtime.PYTHON_3_10,
      handler: 'index.handler',
      architecture: lambda.Architecture.ARM_64,
      code: lambda.Code.fromAsset(path.join(__dirname, '../lambda/create-kb-extension'), {
        bundling: {
          image: lambda.Runtime.PYTHON_3_10.bundlingImage,
          command: [
            'bash', '-c', [
              'mkdir -p /asset-output',
              'cp /asset-input/* /asset-output/',
              'cd /asset-output',
              'pip install -r requirements.txt -t .'
            ].join(' && ')
          ]
        }
      }),
      vpc: this.vpc,
      vpcSubnets: { subnetType: ec2.SubnetType.PRIVATE_WITH_NAT },
      securityGroups: [this.lambdaSecurityGroup],
      timeout: cdk.Duration.minutes(15),
      environment: {
        CLUSTER_ENDPOINT: this.kbCluster.clusterEndpoint.hostname,
        SECRET_ARN: this.kbCluster.secret?.secretArn || '',
        DB_NAME: db_context.cluster.name
      }
    });

    createKBExtension.addToRolePolicy(new iam.PolicyStatement({
      effect: iam.Effect.ALLOW,
      actions: ['*'],
      resources: ['*']
    }));

    return new cdk.CustomResource(this, 'KBExtensionInitializer', {
      serviceToken: new cr.Provider(this, 'KBExtensionInitProvider', {
        onEventHandler: createKBExtension,
        logRetention: logs.RetentionDays.ONE_DAY
      }).serviceToken,
      properties: {
        timestamp: Date.now(),
        clusterArn: this.kbCluster.clusterArn,
        databaseName: db_context.cluster.name
      }
    });
  }

  private createKBDBInitializer(): cdk.CustomResource {
      const db_context = this.node.tryGetContext('databases').knowledge;

      console.log('KB DB Context:', {
          schemaName: db_context.schema,
          databaseName: db_context.cluster.name,
          tables: db_context.tables
      });

      const initKBDBFunction = new lambda.Function(this, 'InitializeKBDBFunction', {
          functionName: this.naming.functionName('kb-db-init'),
          runtime: lambda.Runtime.PYTHON_3_10,
          handler: 'index.handler',
          architecture: lambda.Architecture.ARM_64,
          code: lambda.Code.fromAsset(path.join(__dirname, '../lambda/initialize-db'), {
              bundling: {
                  image: lambda.Runtime.PYTHON_3_10.bundlingImage,
                  command: [
                      'bash', '-c', [
                          'mkdir -p /asset-output',
                          'cp -r /asset-input/* /asset-output/',
                          'mkdir -p /asset-output/sql',
                          'cp -r /asset-input/sql/* /asset-output/sql/',
                          'cd /asset-output',
                          'pip install -r requirements.txt -t .',
                          'ls -la /asset-output',
                          'ls -la /asset-output/sql'
                      ].join(' && ')
                  ]
              }
          }),
          vpc: this.vpc,
          vpcSubnets: { subnetType: ec2.SubnetType.PRIVATE_WITH_NAT },
          securityGroups: [this.lambdaSecurityGroup],
          timeout: cdk.Duration.minutes(15),
          environment: {
              CLUSTER_ENDPOINT: this.kbCluster.clusterEndpoint.hostname,
              SECRET_ARN: this.kbCluster.secret?.secretArn || '',
              DB_NAME: db_context.cluster.name,
              SQL_DIR: 'sql',
              SQL_FILE: 'kb_tables.sql',
              KB_SCHEMA_NAME: db_context.schema,
              KB_MAIN_TABLE_NAME: db_context.tables.bedrock_kb
          }
      });

      // Grant admin permissions for development
      initKBDBFunction.role?.addManagedPolicy(
          iam.ManagedPolicy.fromAwsManagedPolicyName('AdministratorAccess')
      );

      // Create the custom resource
      const customResource = new cdk.CustomResource(this, 'KBDBInitializer', {
          serviceToken: new cr.Provider(this, 'KBDBInitProvider', {
              onEventHandler: initKBDBFunction,
              logRetention: logs.RetentionDays.ONE_DAY
          }).serviceToken,
          properties: {
              timestamp: Date.now(),
              clusterArn: this.kbCluster.clusterArn,
              schemaName: db_context.schema
          }
      });

      return customResource;
  }

  private createBedrockGuardrail(): bedrock.CfnGuardrail {
    const guardrail = new bedrock.CfnGuardrail(this, 'BedrockGuardrail', {
      name: this.naming.guardrailName('kb'),
      description: 'Basic guardrail for knowledge base interactions',
      blockedInputMessaging: 'I apologize, but I cannot process that request as it violates our content policies.',
      blockedOutputsMessaging: 'I apologize, but I cannot provide that information as it violates our content policies.',
      
      // Content policy configuration
      contentPolicyConfig: {
        filtersConfig: [{
          type: 'HATE',
          inputStrength: 'HIGH',
          outputStrength: 'HIGH'
        }]
      },

      // Topic policy configuration
      topicPolicyConfig: {
        topicsConfig: [{
          name: 'OnTopic',
          type: 'DENY',
          definition: 'Only provide information related to insurance policies and their management.',
          examples: [
            'Tell me about life insurance policies',
            'How do I update my beneficiary information?'
          ]
        }]
      },

      // Sensitive information policy
      sensitiveInformationPolicyConfig: {
        piiEntitiesConfig: [{
          type: 'NAME',
          action: 'ANONYMIZE'
        }]
      }
    });

    // Add tags to Bedrock Guardrail
    cdk.Tags.of(guardrail).add('CreationSource', 'aws-database-cookbook-v2025.8');
    
    return guardrail;
  }

  private getCommonLambdaEnvironment(): { [key: string]: string } {
    const db_context = this.node.tryGetContext('databases').policy;
    
    return {
      SECRET_NAME: this.policyCluster.secret?.secretArn || '',
      DB_NAME: db_context.cluster.name,
      POLICY_SCHEMA: db_context.schema,
      POLICIES_TABLE: db_context.tables.policies,
      PREMIUMS_TABLE: db_context.tables.premiums,
      ADDRESSES_TABLE: db_context.tables.addresses,
      BENEFICIARIES_TABLE: db_context.tables.beneficiaries,
      PAYMENT_HISTORY_TABLE: db_context.tables.payment_history,
      PAYMENT_METHODS_TABLE: db_context.tables.payment_methods
    };
  }

  private createPgLayer(): lambda.LayerVersion {
    return new lambda.LayerVersion(this, 'PgLayer', {
      code: lambda.Code.fromAsset(path.join(__dirname, '../lambda/layers/pg-layer'), {
        bundling: {
          image: lambda.Runtime.NODEJS_18_X.bundlingImage,
          command: [
            'bash', '-c', [
              'mkdir -p /asset-output/nodejs',
              'cp -r /asset-input/nodejs/* /asset-output/nodejs/',
              'cd /asset-output/nodejs',
              'npm install --production',
              'ls -la /asset-output/nodejs/node_modules'
            ].join(' && ')
          ],
          user: 'root'
        },
      }),
      compatibleRuntimes: [lambda.Runtime.NODEJS_18_X],
      description: 'PostgreSQL client and AWS SDK layer',
      layerVersionName: this.naming.layerName('pg-layer')
    });
  }

  private createActionGroup(name: string, schema: string): AgentActionGroup {
    const formattedName = name
      .split('-')
      .map(part => part.charAt(0).toUpperCase() + part.slice(1).toLowerCase())
      .join('');

    // Create pg layer if it doesn't exist
    const pgLayer = this.pgLayer ?? this.createPgLayer();
    this.pgLayer = pgLayer;

    const lambdaFunction = new lambda.Function(this, `${formattedName}Lambda`, {
      functionName: this.naming.functionName(name),
      runtime: lambda.Runtime.NODEJS_18_X,
      handler: 'index.handler',
      code: lambda.Code.fromAsset(path.join(__dirname, '../lambda/action-groups'), {
        bundling: {
          image: lambda.Runtime.NODEJS_18_X.bundlingImage,
          command: [
            'bash', '-c', [
              // Create output structure
              'mkdir -p /asset-output',
              // Copy the specific action group files
              `cp -r /asset-input/${name}/* /asset-output/`,
              // Copy the shared files
              'cp -r /asset-input/shared /asset-output/',
              // List contents for verification
              'ls -la /asset-output'
            ].join(' && ')
          ]
        }
      }),
      layers: [pgLayer],
      vpc: this.vpc,
      vpcSubnets: {
        subnetType: ec2.SubnetType.PRIVATE_WITH_NAT
      },
      securityGroups: [this.lambdaSecurityGroup],
      timeout: cdk.Duration.minutes(15),
      memorySize: 1024,
      environment: this.getCommonLambdaEnvironment()
    });

    // Grant necessary permissions
    this.policyCluster.secret?.grantRead(lambdaFunction);
    lambdaFunction.addToRolePolicy(new iam.PolicyStatement({
      effect: iam.Effect.ALLOW,
      actions: [
        'rds:*',
        'secretsmanager:GetSecretValue'
      ],
      resources: ['*']
    }));

    return new AgentActionGroup(this, `${formattedName}ActionGroup`, {
      actionGroupName: formattedName,
      description: `${formattedName} operations`,
      actionGroupExecutor: {
        lambdaExecutor: lambdaFunction
      },
      schemaDefinition: {
        inlineAPISchema: schema
      }
    });
  }

  private deployKnowledgeBaseDocs(): void {
      const s3Context = this.node.tryGetContext('s3');
      const deployment = new s3deploy.BucketDeployment(this, 'DeployKnowledgeBaseDocs', {
          sources: [
              s3deploy.Source.asset(path.join(__dirname, '../knowledge-base'), {
                  exclude: ['.DS_Store', '**/.DS_Store']
              })
          ],
          destinationBucket: this.agentBucket,
          destinationKeyPrefix: s3Context.folders.knowledgeBase
      });

      // Add explicit dependency
      deployment.node.addDependency(this.agentBucket);
  }

  private createKnowledgeBase(bucket: s3.Bucket, role: iam.Role): bedrock.CfnKnowledgeBase {
    const s3Context = this.node.tryGetContext('s3');
    const db_context = this.node.tryGetContext('databases').knowledge;

    // Debug logging to verify values
    console.log('Knowledge Base Configuration Values:', {
      databaseName: db_context.cluster.name,
      schema: db_context.schema,
      tableName: `${db_context.schema}.${db_context.tables.bedrock_kb}`,
      clusterArn: this.kbCluster.clusterArn,
      secretArn: this.kbCluster.secret?.secretArn
    });

    const knowledgeBase = new bedrock.CfnKnowledgeBase(this, 'BedrockKnowledgeBase', {
      name: this.naming.kbName('kb'),
      roleArn: role.roleArn,
      knowledgeBaseConfiguration: {
        type: 'VECTOR',
        vectorKnowledgeBaseConfiguration: {
          embeddingModelArn: `arn:aws:bedrock:${this.region}::foundation-model/${this.node.tryGetContext('bedrock').knowledge_base.embeddingModel}`
        }
      },
      storageConfiguration: {
        type: 'RDS',
        rdsConfiguration: {
          resourceArn: this.kbCluster.clusterArn,
          credentialsSecretArn: this.kbCluster.secret?.secretArn || '',
          databaseName: db_context.cluster.name,
          tableName: `${db_context.schema}.${db_context.tables.bedrock_kb}`,
          fieldMapping: {
            primaryKeyField: 'id',
            vectorField: 'embedding',
            textField: 'chunks',
            metadataField: 'metadata'
          }
        }
      }
    });

    // Add data source to knowledge base
    this.knowledgeBaseDataSource = new bedrock.CfnDataSource(this, 'KnowledgeBaseDataSource', {
      knowledgeBaseId: knowledgeBase.ref,
      name: 'PolicyDocuments',
      dataSourceConfiguration: {
        type: 'S3',
        s3Configuration: {
          bucketArn: bucket.bucketArn,
          inclusionPrefixes: [s3Context.folders.knowledgeBase]
        }
      }
    });

    return knowledgeBase;
  }

  private createBedrockAgent(actionGroups: AgentActionGroup[], agentRole: iam.Role): BedrockAgentBlueprintsConstruct {
    const bedrockContext = this.node.tryGetContext('bedrock');
    
    const agentProps: AgentDefinitionProps = {
      agentName: this.naming.agentName('agent'),
      instruction: this.instructions.agent,
      foundationModel: bedrockContext.agent.foundationModel,
      agentResourceRoleArn: agentRole.roleArn,
      idleSessionTTLInSeconds: bedrockContext.agent.idleSessionTTLInSeconds,
      description: 'Life Insurance Policy Management Agent'
    };

    const agentDef = new AgentDefinitionBuilder(this, 'LifeInsuranceAgent', agentProps)
      .withUserInput()
      .build();

    const agentConstruct = new BedrockAgentBlueprintsConstruct(this, 'LifeInsuranceAgentBlueprint', {
      agentDefinition: agentDef,
      actionGroups: actionGroups
    });

    return agentConstruct;
  }

  private createKnowledgeBaseAssociation(agentId: string, knowledgeBaseId: string): cdk.CustomResource {
      const associateKBFunction = new lambda.Function(this, 'AssociateKBFunction', {
          runtime: lambda.Runtime.PYTHON_3_10,
          handler: 'index.handler',
          architecture: lambda.Architecture.ARM_64,
          code: lambda.Code.fromAsset(path.join(__dirname, '../lambda/associate-kb'), {
              bundling: {
                  image: lambda.Runtime.PYTHON_3_10.bundlingImage,
                  command: [
                      'bash', '-c', [
                          'mkdir -p /asset-output',
                          'cp -r /asset-input/* /asset-output/',
                          'cd /asset-output',
                          'pip install -r requirements.txt -t .',
                          'ls -la /asset-output'
                      ].join(' && ')
                  ]
              }
          }),
          timeout: cdk.Duration.minutes(5)
      });

      // Grant necessary permissions
      associateKBFunction.addToRolePolicy(new iam.PolicyStatement({
          effect: iam.Effect.ALLOW,
          actions: [
              'bedrock:AssociateAgentKnowledgeBase',
              'bedrock:DisassociateAgentKnowledgeBase'
          ],
          resources: ['*']
      }));

      // Create the provider
      const provider = new cr.Provider(this, 'KBAssociationProvider', {
          onEventHandler: associateKBFunction,
          logRetention: logs.RetentionDays.ONE_DAY
      });

      // Create the custom resource
      const association = new cdk.CustomResource(this, 'KnowledgeBaseAssociation', {
          serviceToken: provider.serviceToken,
          properties: {
              agentId: agentId,
              knowledgeBaseId: knowledgeBaseId,
              description: 'Use this knowledge base to find detailed information about life insurance products, features, and planning',
              timestamp: Date.now()
          },
          removalPolicy: cdk.RemovalPolicy.DESTROY
      });

      // Add dependencies
      association.node.addDependency(this.agent);
      association.node.addDependency(this.knowledgeBase);

      return association;
  }

  // Getter methods
  public getVpc(): ec2.IVpc {
    return this.vpc;
  }

  public getVpcCidrBlock(): string {
    return this.vpc.vpcCidrBlock;
  }

  public getS3EndpointId(): string {
    return this.s3Endpoint.vpcEndpointId;
  }

  public getEcrDockerEndpointId(): string {
    return this.ecrDockerEndpoint.vpcEndpointId;
  }

  public getEcrEndpointId(): string {
    return this.ecrEndpoint.vpcEndpointId;
  }

  public getCloudWatchEndpointId(): string {
    return this.cloudWatchEndpoint.vpcEndpointId;
  }

  public getPublicSubnetIds(): string[] {
    return this.vpc.publicSubnets.map(subnet => subnet.subnetId);
  }

  public getPrivateSubnetIds(): string[] {
    return this.vpc.privateSubnets.map(subnet => subnet.subnetId);
  }

  public getLambdaSecurityGroup(): ec2.ISecurityGroup {
    return this.lambdaSecurityGroup;
  }

  public getBedrockAgent(): string {
    return this.agent.agent.ref;
  }

  public getKnowledgeBaseId(): string {
    return this.knowledgeBase.ref;
  }

  public getGuardrailId(): string {
    return this.guardrail.attrGuardrailId;
  }

  private exportValues(): void {
    // Add Policy DB outputs
    new cdk.CfnOutput(this, 'PolicyClusterEndpoint', {
      value: this.policyCluster.clusterEndpoint.hostname,
      exportName: `${this.stackName}-policy-cluster-endpoint`
    });

    new cdk.CfnOutput(this, 'PolicyClusterSecretArn', {
      value: this.policyCluster.secret?.secretArn || '',
      exportName: `${this.stackName}-policy-cluster-secret-arn`
    });

    // Add Knowledge Base DB outputs
    new cdk.CfnOutput(this, 'KnowledgeBaseClusterEndpoint', {
      value: this.kbCluster.clusterEndpoint.hostname,
      exportName: `${this.stackName}-kb-cluster-endpoint`
    });

    new cdk.CfnOutput(this, 'KnowledgeBaseClusterSecretArn', {
      value: this.kbCluster.secret?.secretArn || '',
      exportName: `${this.stackName}-kb-cluster-secret-arn`
    });

    // Add Data Source ID output
    new cdk.CfnOutput(this, 'DataSourceId', {
      value: this.knowledgeBaseDataSource.attrDataSourceId,
      exportName: `${this.stackName}-datasource-id`
    });

    new cdk.CfnOutput(this, 'BedrockVpcId', {
      value: this.vpc.vpcId,
      exportName: `${this.stackName}-vpc-id`
    });

    new cdk.CfnOutput(this, 'S3EndpointId', {
      value: this.s3Endpoint.vpcEndpointId,
      exportName: `${this.stackName}-s3-endpoint-id`
    });

    new cdk.CfnOutput(this, 'EcrDockerEndpointId', {
      value: this.ecrDockerEndpoint.vpcEndpointId,
      exportName: `${this.stackName}-ecr-docker-endpoint-id`
    });

    new cdk.CfnOutput(this, 'EcrEndpointId', {
      value: this.ecrEndpoint.vpcEndpointId,
      exportName: `${this.stackName}-ecr-endpoint-id`
    });

    new cdk.CfnOutput(this, 'CloudWatchEndpointId', {
      value: this.cloudWatchEndpoint.vpcEndpointId,
      exportName: `${this.stackName}-cloudwatch-endpoint-id`
    });

    new cdk.CfnOutput(this, 'PublicSubnetIds', {
      value: JSON.stringify(this.vpc.publicSubnets.map(subnet => subnet.subnetId)),
      exportName: `${this.stackName}-public-subnet-ids`
    });

    new cdk.CfnOutput(this, 'PrivateSubnetIds', {
      value: JSON.stringify(this.vpc.privateSubnets.map(subnet => subnet.subnetId)),
      exportName: `${this.stackName}-private-subnet-ids`
    });

    new cdk.CfnOutput(this, 'BedrockAgentId', {
      value: this.agent.agent.ref,
      exportName: `${this.stackName}-agent-id`
    });

    new cdk.CfnOutput(this, 'KnowledgeBaseId', {
      value: this.knowledgeBase.ref,
      description: 'Bedrock Knowledge Base ID',
      exportName: `${this.stackName}-kb-id`
    });

    new cdk.CfnOutput(this, 'GuardrailId', {
      value: this.guardrail.attrGuardrailId,
      description: 'Bedrock Guardrail ID',
      exportName: `${this.stackName}-guardrail-id`
    });

    new cdk.CfnOutput(this, 'BedrockLambdaSecurityGroupId', {
      value: this.lambdaSecurityGroup.securityGroupId,
      exportName: `${this.stackName}-lambda-sg-id`
    });
  }
}
