import * as path from "path";
import * as fs from "fs";
import { Construct } from "constructs";
import { Function, Runtime, Code } from "aws-cdk-lib/aws-lambda";
import { IBucket } from "aws-cdk-lib/aws-s3";

// Interface for Lambda configuration, used to type-check the JSON config files.
interface LambdaConfig {
  functionName: string; // The name of the Lambda function.
  handler: string; // The function handler.
  runtime: string; // Runtime as a string, will be mapped to Runtime enum.
  s3Key: string; // S3 key where the Lambda code artifact is stored.
  description?: string; // Optional description for the Lambda function.
  memorySize?: number; // Optional memory size for the Lambda function.
  environment?: { [key: string]: string }; // Optional environment variables for the Lambda function.
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
    const configDir = path.resolve(__dirname, "../config/lambda/");

    // Read and filter the configuration files, excluding any that are disabled.
    const files = fs
      .readdirSync(configDir)
      .filter((file) => file.endsWith(".json") && !file.includes("disabled"));

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
      const filePath = path.join(configDir, file);

      // Read and parse the configuration file.
      const config: LambdaConfig = JSON.parse(
        fs.readFileSync(filePath, "utf-8")
      );

      // Map the runtime string to the corresponding Runtime enum.
      const runtime = (Runtime as any)[config.runtime];

      // Throw an error if the runtime is invalid.
      if (!runtime) {
        throw new Error(`Invalid runtime specified: ${config.runtime}`);
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
      });
    });
  }
}
