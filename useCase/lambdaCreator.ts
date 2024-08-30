import * as path from "path";
import * as fs from "fs";
import { Construct } from "constructs";
import { Function, Runtime, Code } from "aws-cdk-lib/aws-lambda";
import { IBucket } from "aws-cdk-lib/aws-s3";

interface LambdaConfig {
  functionName: string;
  handler: string;
  runtime: string; // Changed to string to parse from JSON
  s3Key: string;
  description?: string;
  memorySize?: number;
  environment?: { [key: string]: string };
}

export class LambdaCreator {
  static createLambdas(scope: Construct, lambdaArtifactBucket: IBucket) {
    const configDir = path.resolve(__dirname, "../config/lambda/");
    const files = fs
      .readdirSync(configDir)
      .filter((file) => file.endsWith(".json") && !file.includes("disabled"));

    if (files.length === 0) {
      console.log(
        "No valid Lambda configuration files found. Skipping deployment of lambdas.\n",
        "You need to create a Lambda configuration file in the config/lambda directory to deploy lambdas.\n"
      );
      return;
    }

    files.forEach((file) => {
      const filePath = path.join(configDir, file);
      const config: LambdaConfig = JSON.parse(
        fs.readFileSync(filePath, "utf-8")
      );

      const runtime = (Runtime as any)[config.runtime]; // Map string to Runtime enum

      if (!runtime) {
        throw new Error(`Invalid runtime specified: ${config.runtime}`);
      }

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
