// lib/utils/naming.ts

export class NamingUtils {
  private readonly dbPrefix: string;  // For database resources (with underscores)
  private readonly resourcePrefix: string;  // For other AWS resources (with hyphens)
  private readonly maxLength: number = 63;

  constructor(stackPrefix: string) {
    this.dbPrefix = stackPrefix.replace(/-/g, '_'); // Convert any hyphens to underscores for database names
    this.resourcePrefix = stackPrefix; // Keep hyphens for resource names (already has hyphens from APP_NAME)
  }

  private sanitize(name: string): string {
    return name.toLowerCase()
      .replace(/([A-Z])/g, '-$1')
      .replace(/[^a-z0-9-]/g, '-')
      .replace(/_/g, '-')
      .replace(/-+/g, '-')
      .replace(/^-|-$/g, '');
  }

  private sanitizeDbName(name: string): string {
    return name.toLowerCase()
      .replace(/[^a-z0-9_]/g, '_')
      .replace(/-/g, '_')
      .replace(/_+/g, '_')
      .replace(/^_|_$/g, '');
  }

  private truncate(str: string, maxLength: number): string {
    if (str.length <= maxLength) return str;
    return str.slice(0, maxLength);
  }

  private generateResourceName(resourceType: string, suffix?: string): string {
    const parts = [this.resourcePrefix, resourceType];
    if (suffix) parts.push(suffix);
    
    const name = parts.join('-');
    return this.truncate(this.sanitize(name), this.maxLength);
  }

  // Standard AWS resource naming methods
  public stackName(name: string): string {
    return this.generateResourceName('stack', name);
  }

  public functionName(name: string): string {
    return this.generateResourceName('function', name);
  }

  public layerName(name: string): string {
    return this.generateResourceName('layer', name);
  }

  public bucketName(type: string): string {
    const account = process.env.CDK_DEFAULT_ACCOUNT;
    const region = process.env.CDK_DEFAULT_REGION;
    return this.generateResourceName(`${type}-${account}-${region}`);
  }

  public repositoryName(name: string): string {
    return this.generateResourceName('repository', name);
  }

  // Database related naming methods
  public tableName(name: string): string {
    const parts = [this.sanitizeDbName(this.dbPrefix), this.sanitizeDbName(name)];
    return this.truncate(parts.join('_'), this.maxLength);
  }

  public databaseName(name: string): string {
    const parts = [this.sanitizeDbName(this.dbPrefix), this.sanitizeDbName(name)];
    return this.truncate(parts.join('_'), this.maxLength);
  }

  public clusterIdentifier(name: string): string {
    return this.generateResourceName('cluster', name);
  }

  public roleName(name: string): string {
    return this.generateResourceName('role', name);
  }

  // Bedrock specific naming methods
  public agentName(name: string): string {
    return this.generateResourceName('agent', name);
  }

  public kbName(name: string): string {
    return this.generateResourceName('kb', name);
  }

  public guardrailName(name: string): string {
    return this.generateResourceName('guardrail', name);
  }

  // Auth related naming methods
  public userPoolName(name: string): string {
    return this.generateResourceName('user-pool', name);
  }

  public userPoolClientName(name: string): string {
    return this.generateResourceName('user-pool-client', name);
  }

  // Container related naming methods
  public clusterName(name: string): string {
    return this.generateResourceName('cluster', name);
  }

  public serviceName(name: string): string {
    return this.generateResourceName('service', name);
  }

  public taskDefinitionName(name: string): string {
    return this.generateResourceName('task', name);
  }

  // Security related naming methods
  public securityGroupName(name: string): string {
    return this.generateResourceName('sg', name);
  }

  public secretName(name: string): string {
    return this.generateResourceName('secret', name);
  }

  // Pipeline related naming methods
  public pipelineName(name: string): string {
    return this.generateResourceName('pipeline', name);
  }

  public projectName(name: string): string {
    return this.generateResourceName('project', name);
  }

  // Monitoring related naming methods
  public logGroupName(name: string): string {
    return this.generateResourceName('logs', name);
  }

  public alarmName(name: string): string {
    return this.generateResourceName('alarm', name);
  }

  // Network related naming methods
  public vpcName(name: string): string {
    return this.generateResourceName('vpc', name);
  }

  public subnetName(name: string): string {
    return this.generateResourceName('subnet', name);
  }

  // Load balancer related naming methods
  public loadBalancerName(name: string): string {
    return this.generateResourceName('alb', name);
  }

  public targetGroupName(name: string): string {
    return this.generateResourceName('tg', name);
  }
}
