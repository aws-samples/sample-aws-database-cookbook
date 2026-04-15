// lib/pipeline-stack.ts

import * as cdk from 'aws-cdk-lib';
import * as s3 from 'aws-cdk-lib/aws-s3';
import * as ec2 from 'aws-cdk-lib/aws-ec2';
import * as ecr from 'aws-cdk-lib/aws-ecr';
import * as iam from 'aws-cdk-lib/aws-iam';
import * as ecs from 'aws-cdk-lib/aws-ecs';
import * as logs from 'aws-cdk-lib/aws-logs';
import * as cr from 'aws-cdk-lib/custom-resources';
import * as codebuild from 'aws-cdk-lib/aws-codebuild';
import * as codepipeline from 'aws-cdk-lib/aws-codepipeline';
import * as codepipeline_actions from 'aws-cdk-lib/aws-codepipeline-actions';
import { Stack } from 'aws-cdk-lib';
import { Construct } from 'constructs';
import { NamingUtils } from './utils/naming';

export interface CodePipelineStackProps extends cdk.StackProps {
  vpcId: string;
  publicSubnetIds: string[];
  privateSubnetIds: string[];
  ecsClusterName: string;
  ecsServiceName: string;
  naming: NamingUtils;
}

export class CodePipelineStack extends cdk.Stack {
  private readonly ecrRepository: ecr.IRepository;

  constructor(scope: Construct, id: string, props: CodePipelineStackProps) {
    super(scope, id, props);

    // Retrieve context values
    const app_context = this.node.tryGetContext('app');
    const s3_context = this.node.tryGetContext('s3');
    const ecr_context = this.node.tryGetContext('ecr');
    const github_context = this.node.tryGetContext('github');
    const dynamodb_context = this.node.tryGetContext('dynamodb');
    const connection_arn = this.node.tryGetContext('connection_arn');

    if (!connection_arn) {
      throw new Error("Missing connection_arn. Deploy with: cdk deploy --context connection_arn=<your-arn>");
    }

    // Create or import ECR repository
    const repo_name = props.naming.repositoryName('streamlit');
    this.ecrRepository = this.createOrImportRepository(repo_name);

    // Import VPC
    const vpc = ec2.Vpc.fromVpcAttributes(this, 'ImportedVpc', {
      vpcId: props.vpcId,
      availabilityZones: this.availabilityZones,
      publicSubnetIds: props.publicSubnetIds,
      privateSubnetIds: props.privateSubnetIds,
    });

    // Create log group for CodeBuild
    const buildLogGroup = new logs.LogGroup(this, 'BuildLogs', {
      retention: logs.RetentionDays.ONE_WEEK,
      removalPolicy: cdk.RemovalPolicy.DESTROY
    });

    // CodeBuild Project with updated configuration
    const build_project = new codebuild.PipelineProject(this, "BuildProject", {
      buildSpec: codebuild.BuildSpec.fromSourceFilename("8_Building_Your_First_GenAI_Application_with_AWS_Data_Foundations/8.3_Building_Your_Life_Insurance_Agent/buildspec.yml"),
      timeout: cdk.Duration.hours(2),
      queuedTimeout: cdk.Duration.hours(8),
      environment: {
        privileged: true,
        buildImage: codebuild.LinuxBuildImage.STANDARD_7_0,
        computeType: codebuild.ComputeType.LARGE,
        environmentVariables: {
          APP_NAME: { value: app_context.name },
          S3_BUCKET: { value: props.naming.bucketName('pipeline') },
          S3_DOCS_PREFIX: { value: s3_context.folders.docs },
          S3_ASSETS_PREFIX: { value: s3_context.folders.assets },
          FEEDBACK_TABLE: { value: props.naming.tableName('feedback') },
          ECR_REPO_URI: { value: this.ecrRepository.repositoryUri },
          AWS_ACCOUNT_ID: { value: Stack.of(this).account },
          AWS_DEFAULT_REGION: { value: Stack.of(this).region },
          IMAGE_REPO_NAME: { value: this.ecrRepository.repositoryName },
          CONTAINER_NAME: { value: `${app_context.name}WebContainer` }
        }
      },
      logging: {
        cloudWatch: {
          enabled: true,
          logGroup: buildLogGroup
        }
      },
      cache: codebuild.Cache.local(
        codebuild.LocalCacheMode.DOCKER_LAYER,
        codebuild.LocalCacheMode.CUSTOM,
        codebuild.LocalCacheMode.SOURCE
      )
    });

    build_project.role?.addManagedPolicy(
      iam.ManagedPolicy.fromAwsManagedPolicyName('AdministratorAccess')
    );
    this.ecrRepository.grantPullPush(build_project.grantPrincipal);

    // Import ECS cluster
    const cluster = ecs.Cluster.fromClusterAttributes(this, 'ImportedCluster', {
      clusterName: props.ecsClusterName,
      vpc: vpc,
      securityGroups: []
    });

    // Import ECS service
    const service = ecs.FargateService.fromFargateServiceAttributes(this, 'ImportedService', {
      cluster,
      serviceName: props.ecsServiceName
    });

    // Pipeline artifacts
    const artifact_bucket = new s3.Bucket(this, "PipelineArtifacts", {
      removalPolicy: cdk.RemovalPolicy.DESTROY,
      autoDeleteObjects: true
    });
    const source_output = new codepipeline.Artifact();
    const build_output = new codepipeline.Artifact();

    // Source stage
    const source_action = new codepipeline_actions.CodeStarConnectionsSourceAction({
      actionName: "Source",
      owner: github_context.owner,
      repo: github_context.repo,
      branch: github_context.branch,
      connectionArn: connection_arn,
      output: source_output,
    });

    // Build stage with timeout
    const build_action = new codepipeline_actions.CodeBuildAction({
      actionName: "Build",
      project: build_project,
      input: source_output,
      outputs: [build_output]
    });

    // Deploy stage
    const deploy_action = new codepipeline_actions.EcsDeployAction({
      actionName: "Deploy",
      service: service,
      input: build_output
    });

    // Create Pipeline with all stages
    const pipeline = new codepipeline.Pipeline(this, "Pipeline", {
      artifactBucket: artifact_bucket,
      stages: [
        {
          stageName: "Source",
          actions: [source_action]
        },
        {
          stageName: "Build",
          actions: [build_action]
        },
        {
          stageName: "Deploy",
          actions: [deploy_action]
        }
      ]
    });

    // Add permissions
    pipeline.role.addManagedPolicy(
      iam.ManagedPolicy.fromAwsManagedPolicyName('AdministratorAccess')
    );
    artifact_bucket.grantReadWrite(pipeline.role);
    this.ecrRepository.grantPullPush(pipeline.role);

    // Outputs
    const image_tag = "latest";
    const image_uri = `${this.ecrRepository.repositoryUri}:${image_tag}`;

    new cdk.CfnOutput(this, "EcrImageUri", {
      value: image_uri,
      description: "The URI of the built Docker image in ECR"
    });
  }

  private createOrImportRepository(repositoryName: string): ecr.IRepository {
    // First, create a custom resource to check if the repository exists
    const repoCheck = new cr.AwsCustomResource(this, 'RepositoryCheck', {
      onCreate: {
        service: 'ECR',
        action: 'describeRepositories',
        parameters: {
          repositoryNames: [repositoryName]
        },
        physicalResourceId: cr.PhysicalResourceId.of(repositoryName),
        ignoreErrorCodesMatching: 'RepositoryNotFoundException'
      },
      onUpdate: {
        service: 'ECR',
        action: 'describeRepositories',
        parameters: {
          repositoryNames: [repositoryName]
        },
        physicalResourceId: cr.PhysicalResourceId.of(repositoryName),
        ignoreErrorCodesMatching: 'RepositoryNotFoundException'
      },
      policy: cr.AwsCustomResourcePolicy.fromSdkCalls({
        resources: cr.AwsCustomResourcePolicy.ANY_RESOURCE
      })
    });

    try {
      // Check if repository exists
      repoCheck.getResponseField('repositories.0.repositoryArn');
      
      // If we get here, repository exists
      console.log(`Found existing ECR repository: ${repositoryName}`);
      return ecr.Repository.fromRepositoryName(
        this,
        'ExistingEcrRepo',
        repositoryName
      );
    } catch (error) {
      // If repository doesn't exist, create it
      console.log(`Creating new ECR repository: ${repositoryName}`);
      return new ecr.Repository(this, 'StreamlitEcrRepo', {
        repositoryName: repositoryName,
        removalPolicy: cdk.RemovalPolicy.DESTROY,
        lifecycleRules: [
          {
            maxImageCount: 3,
            description: 'Keep only 3 most recent images'
          }
        ]
      });
    }
  }

  public getEcrRepository(): ecr.IRepository {
    return this.ecrRepository;
  }
}
