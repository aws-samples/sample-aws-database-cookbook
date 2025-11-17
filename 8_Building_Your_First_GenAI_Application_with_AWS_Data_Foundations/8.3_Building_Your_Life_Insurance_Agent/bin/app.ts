// bin/app.ts

import * as cdk from 'aws-cdk-lib';
import { BedrockStack, BedrockStackProps } from '../lib/bedrock-stack';
import { StreamlitAppStack, StreamlitAppStackProps } from '../lib/streamlit-stack';
import { CodePipelineStack, CodePipelineStackProps } from '../lib/pipeline-stack';
import { NamingUtils } from '../lib/utils/naming';

const app = new cdk.App();

// Get context values
const appContext = app.node.tryGetContext('app');
const vpc_context = app.node.tryGetContext('vpc');

const naming = new NamingUtils(appContext.name);

// Define common environment
const env = {
  account: process.env.CDK_DEFAULT_ACCOUNT,
  region: process.env.CDK_DEFAULT_REGION
};

// Create Bedrock stack first
const bedrockStack = new BedrockStack(app, 'BedrockStack', {
  env,
  stackName: naming.stackName('bedrock'),
  description: 'Bedrock Components Stack',
  naming
} as BedrockStackProps);

// Create Pipeline stack second
const pipelineStack = new CodePipelineStack(app, 'PipelineStack', {
  env,
  stackName: naming.stackName('pipeline'),
  description: 'CI/CD Pipeline Stack',
  vpcId: bedrockStack.getVpc().vpcId,
  publicSubnetIds: bedrockStack.getPublicSubnetIds(),
  privateSubnetIds: bedrockStack.getPrivateSubnetIds(),
  ecsClusterName: `${appContext.name}-cluster`,
  ecsServiceName: `${appContext.name}-service`,
  naming
} as CodePipelineStackProps);

// Create Streamlit stack last
const streamlitStack = new StreamlitAppStack(app, naming.stackName('streamlit'), {
  env,
  stackName: naming.stackName('streamlit'),
  description: 'Streamlit Application Stack',
  bedrockAgentId: bedrockStack.getBedrockAgent(),
  bedrockVpcId: bedrockStack.getVpc().vpcId,
  bedrockLambdaSecurityGroupId: bedrockStack.getLambdaSecurityGroup().securityGroupId,
  bedrockKnowledgeBaseId: bedrockStack.getKnowledgeBaseId(),
  bedrockGuardrailId: bedrockStack.getGuardrailId(),
  publicSubnetIds: bedrockStack.getPublicSubnetIds().slice(0, vpc_context.maxAzs),
  privateSubnetIds: bedrockStack.getPrivateSubnetIds().slice(0, vpc_context.maxAzs),
  vpcCidrBlock: bedrockStack.getVpc().vpcCidrBlock,
  s3EndpointId: bedrockStack.getS3EndpointId(),
  ecrDockerEndpointId: bedrockStack.getEcrDockerEndpointId(),
  ecrEndpointId: bedrockStack.getEcrEndpointId(),
  cloudWatchEndpointId: bedrockStack.getCloudWatchEndpointId(),
  ecrRepository: pipelineStack.getEcrRepository(),
  naming
} as StreamlitAppStackProps);

// Add stack tags
cdk.Tags.of(bedrockStack).add('Project', appContext.name);
cdk.Tags.of(pipelineStack).add('Project', appContext.name);
cdk.Tags.of(streamlitStack).add('Project', appContext.name);

// Set dependencies
pipelineStack.addDependency(bedrockStack);
streamlitStack.addDependency(bedrockStack);
streamlitStack.addDependency(pipelineStack);

app.synth();
