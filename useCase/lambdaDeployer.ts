import { join, resolve } from "path";
import { readdirSync, readFileSync } from "fs";
import { Construct } from "constructs";
import { Function, Runtime, Code } from "aws-cdk-lib/aws-lambda";
import { IBucket } from "aws-cdk-lib/aws-s3";
import { Vpc, SecurityGroup, ISecurityGroup } from "aws-cdk-lib/aws-ec2";
import { Role, IRole } from "aws-cdk-lib/aws-iam";
import { Duration } from "aws-cdk-lib";

// Interface for Lambda configuration, used to type-check the JSON config files.
interface LambdaConfig {
  functionName: string;
  handler: string;
  runtime: string;
  s3Key: string;
  description?: string;
  memorySize?: number;
  environment?: { [key: string]: string };
  timeout?: number;
  vpc?: string;
  securityGroups?: string[];
  roleArn?: string;
  logRetention?: number;
}

export class LambdaDeployer {
  /**
   * Deploys Lambda functions based on configuration files in the config/lambda directory.
   *
   * @param scope - The construct scope in which the Lambdas are deployed.
   * @param lambdaArtifactBucket - The S3 bucket where the Lambda code artifacts are stored.
   */
  static deployLambdas(scope: Construct, lambdaArtifactBucket: IBucket) {
    // Resolve the directory containing the Lambda configuration files.
    const configDir = resolve(__dirname, "../config/lambda/");

    // Read and filter the configuration files, excluding any that are disabled.
    const files = readdirSync(configDir).filter(
      (file) => file.endsWith(".json") && !file.includes("disabled")
    );

    // If no valid configuration files are found, log a message and skip deployment.
    if (files.length === 0) {
      console.log(
        "No valid Lambda configuration files found. Skipping deployment of lambdas.\n",
        "You need to create a Lambda configuration file in the config/lambda directory to deploy lambdas.\n"
      );
      return;
    }

    // Iterate over each configuration file and deploy the corresponding Lambda function.
    files.forEach((file) => {
      const filePath = join(configDir, file);

      // Read and parse the configuration file.
      const config: LambdaConfig = JSON.parse(readFileSync(filePath, "utf-8"));

      // Map the runtime string to the corresponding Runtime enum.
      const runtime = (Runtime as any)[config.runtime];

      // Throw an error if the runtime is invalid.
      if (!runtime) {
        throw new Error(`Invalid runtime specified: ${config.runtime}`);
      }

      // Resolve the VPC and security groups if specified.
      let vpc;
      if (config.vpc) {
        vpc = Vpc.fromLookup(scope, `${config.functionName}Vpc`, {
          vpcId: config.vpc,
        });
      }

      let securityGroups: ISecurityGroup[] = [];
      if (config.securityGroups) {
        securityGroups = config.securityGroups.map((sgId) =>
          SecurityGroup.fromSecurityGroupId(
            scope,
            `${config.functionName}SG-${sgId}`,
            sgId
          )
        );
      }

      // Resolve the IAM role if specified.
      let role: IRole | undefined;
      if (config.roleArn) {
        role = Role.fromRoleArn(
          scope,
          `${config.functionName}Role`,
          config.roleArn
        );
      }

      // Deploy the Lambda function using the specified configuration.
      new Function(scope, config.functionName, {
        functionName: config.functionName,
        runtime: runtime,
        handler: config.handler,
        code: Code.fromBucket(lambdaArtifactBucket, config.s3Key),
        description: config.description,
        memorySize: config.memorySize,
        environment: config.environment,
        timeout: config.timeout ? Duration.seconds(config.timeout) : undefined,
        vpc: vpc,
        securityGroups: securityGroups.length > 0 ? securityGroups : undefined,
        role: role,
        logRetention: config.logRetention,
      });
    });
  }
}
