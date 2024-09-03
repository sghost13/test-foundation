import { BlockPublicAccess, Bucket, EventType } from "aws-cdk-lib/aws-s3";
import { LambdaDeployer } from "../useCase/lambdaDeployer";
import { RemovalPolicy, Stack, StackProps } from "aws-cdk-lib";
import { Construct } from "constructs";
import { Runtime } from "aws-cdk-lib/aws-lambda";
import { Policy, PolicyStatement } from "aws-cdk-lib/aws-iam";
import { NodejsFunction, SourceMapMode } from "aws-cdk-lib/aws-lambda-nodejs";
import { LambdaDestination } from "aws-cdk-lib/aws-s3-notifications";
import { resolve } from "path";

// Stack to manage deployment and updating of all application Lambdas
export class LambdaManagerStack extends Stack {
  constructor(scope: Construct, id: string, props?: StackProps) {
    super(scope, id, props);

    // S3 bucket to store Lambda artifacts
    const lambdaArtifactBucket = new Bucket(this, "lambda-artifact-bucket", {
      bucketName: "sg-lambda-artifact-bucket",
      removalPolicy: RemovalPolicy.DESTROY,
      autoDeleteObjects: true,
      blockPublicAccess: BlockPublicAccess.BLOCK_ALL,
    });

    // Deploy application Lambdas based on configuration files
    LambdaDeployer.deployLambdas(this, lambdaArtifactBucket);

    // Deploy the lambda-updater function
    // This Lambda is part of the CI/CD infrastructure and is used to update other Lambdas
    const lambdaUpdater = new NodejsFunction(this, "lambda-updater", {
      functionName: "lambda-updater",
      runtime: Runtime.NODEJS_18_X,
      entry: resolve(__dirname, "../lambda/lambda-updater/index.ts"),
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

    // Example function; remove if not needed
    const hello2 = new NodejsFunction(this, "hello2", {
      functionName: "hello2",
      runtime: Runtime.NODEJS_18_X,
      entry: resolve(__dirname, "../lambda/hello/index.ts"),
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
    // END Example function

    // Grant necessary permissions to the lambda-updater function
    lambdaUpdater.role?.attachInlinePolicy(
      new Policy(this, "lambda-updater-policy", {
        statements: [
          new PolicyStatement({
            actions: [
              "lambda:UpdateFunctionCode", // Allow updating Lambda function code
              "lambda:ListFunctions", // Allow listing all Lambda functions in the account
            ],
            resources: [
              `arn:aws:lambda:${this.region}:${this.account}:function:*`, // Restrict to functions within this account and region
            ],
          }),
        ],
      })
    );

    // Grant read access to the lambda-updater Lambda for the artifact bucket
    lambdaArtifactBucket.grantRead(lambdaUpdater);

    // Notify the lambda-updater Lambda when a new artifact is uploaded to the bucket
    lambdaArtifactBucket.addEventNotification(
      EventType.OBJECT_CREATED,
      new LambdaDestination(lambdaUpdater)
    );
  }
}
