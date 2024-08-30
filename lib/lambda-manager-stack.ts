import { BlockPublicAccess, Bucket, EventType } from "aws-cdk-lib/aws-s3";
import { LambdaCreator } from "../useCase/lambdaCreator";
import { RemovalPolicy, Stack, StackProps } from "aws-cdk-lib";
import { Construct } from "constructs";
import { Runtime } from "aws-cdk-lib/aws-lambda";
import { Policy, PolicyStatement } from "aws-cdk-lib/aws-iam";
import { NodejsFunction, SourceMapMode } from "aws-cdk-lib/aws-lambda-nodejs";
import { LambdaDestination } from "aws-cdk-lib/aws-s3-notifications";
import * as path from "path";

// Lambda Manager Stack
// This stacks purpose is to deploy and update *all* -application- lambdas

export class LambdaManagerStack extends Stack {
  constructor(scope: Construct, id: string, props?: StackProps) {
    super(scope, id, props);

    // Create a bucket to hold the lambda artifacts
    const lambdaArtifactBucket = new Bucket(this, "lambda-artifact-bucket", {
      bucketName: "sg-lambda-artifact-bucket",
      removalPolicy: RemovalPolicy.DESTROY,
      autoDeleteObjects: true,
      blockPublicAccess: BlockPublicAccess.BLOCK_ALL,
    });

    // Create the lambdas from configuration files, passing the lambda-artifact-bucket reference
    LambdaCreator.createLambdas(this, lambdaArtifactBucket);

    // Deploy the lambda-updater function
    // See the ../lambda/lambda-updater/index.ts file for more details
    // The lambda-updater lambda is part of the foundational ci cd infrastructure
    // Uses the NodejsFunction to create the lambda, so the bundle step is included in the cdk code below
    const lambdaUpdater = new NodejsFunction(this, "lambda-updater", {
      functionName: "lambda-updater",
      runtime: Runtime.NODEJS_18_X,
      entry: path.resolve(__dirname, "../lambda/lambda-updater/index.ts"),
      handler: "index.handler",
      memorySize: 1024,
      environment: {
        AWS_ACCOUNT_ID: this.account,
      },
      bundling: {
        minify: true,
        sourceMap: true,
        sourceMapMode: SourceMapMode.DEFAULT,
        sourcesContent: true,
        target: "node18",
        externalModules: ["@aws-sdk/client-s3", "@aws-sdk/client-lambda"],
      },
    });

    // DELETE THIS
    const hello2 = new NodejsFunction(this, "hello2", {
      functionName: "hello2",
      runtime: Runtime.NODEJS_18_X,
      entry: path.resolve(__dirname, "../lambda/hello/index.ts"),
      handler: "index.handler",
      environment: {},
      bundling: {
        minify: true,
        sourceMap: true,
        sourceMapMode: SourceMapMode.DEFAULT,
        sourcesContent: true,
        target: "node18",
      },
    });
    // END DELETE THIS

    // Grant the lambdaUpdater lambda role a policy to allow it to update lambda code
    // AWS automatically creates a role for lambdas to assume, we just want to add policy permissions to it
    //TODO refine this policy to only needed permissions
    lambdaUpdater.role?.attachInlinePolicy(
      new Policy(this, "lambda-updater-policy", {
        statements: [
          new PolicyStatement({
            actions: ["lambda:*"],
            resources: [
              `arn:aws:lambda:${this.region}:${this.account}:function:*`,
            ],
          }),
        ],
      })
    );

    // Grant the lambdaUpdater lambda read access to the lambda-artifact-bucket
    lambdaArtifactBucket.grantRead(lambdaUpdater);

    // Add an event notification to the lambda-artifact-bucket, that alerts the lambdaUpdater lambda when a lambda artifact is updated
    lambdaArtifactBucket.addEventNotification(
      EventType.OBJECT_CREATED,
      new LambdaDestination(lambdaUpdater)
    );
  }
}
