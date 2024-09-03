import { RemovalPolicy, Stack, StackProps } from "aws-cdk-lib";
import {
  Distribution,
  OriginAccessIdentity,
  ViewerProtocolPolicy,
} from "aws-cdk-lib/aws-cloudfront";
import { S3Origin } from "aws-cdk-lib/aws-cloudfront-origins";
import {
  CanonicalUserPrincipal,
  Policy,
  PolicyStatement,
} from "aws-cdk-lib/aws-iam";
import { Runtime } from "aws-cdk-lib/aws-lambda";
import { NodejsFunction, SourceMapMode } from "aws-cdk-lib/aws-lambda-nodejs";
import { BlockPublicAccess, Bucket, EventType } from "aws-cdk-lib/aws-s3";
import { LambdaDestination } from "aws-cdk-lib/aws-s3-notifications";
import { Construct } from "constructs";
import { resolve } from "path";

// CloudfrontManagerStack: A CDK stack that deploys CloudFront distributions
// and their associated resources such as S3 buckets and Lambda functions.

export class CloudfrontManagerStack extends Stack {
  constructor(scope: Construct, id: string, props?: StackProps) {
    super(scope, id, props);

    // S3 bucket to hold artifacts for CloudFront and app code artifacts
    const cloudfrontArtifactBucket = new Bucket(
      this,
      "sg-cloudfront-artifact-bucket",
      {
        bucketName: "cloudfront-artifact-bucket",
        removalPolicy: RemovalPolicy.DESTROY,
        autoDeleteObjects: true,
        blockPublicAccess: BlockPublicAccess.BLOCK_ALL,
      }
    );

    // Create an Origin Access Identity (OAI) for secure access from CloudFront to S3.
    const originAccessIdentity = new OriginAccessIdentity(
      this,
      "cloudfront-updater-oai",
      {
        comment: "OAI for CloudFront updater to access S3",
      }
    );

    // Grant read permissions to CloudFront's OAI for accessing S3 objects.
    cloudfrontArtifactBucket.addToResourcePolicy(
      new PolicyStatement({
        actions: ["s3:GetObject"], // Allow CloudFront to retrieve objects.
        resources: [cloudfrontArtifactBucket.arnForObjects("*")],
        principals: [
          new CanonicalUserPrincipal(
            originAccessIdentity.cloudFrontOriginAccessIdentityS3CanonicalUserId
          ),
        ],
      })
    );

    // Create CloudFront distribution configured to serve content from S3.
    const app1Distribution = new Distribution(this, "app1-distribution", {
      defaultRootObject: "index.html",
      defaultBehavior: {
        origin: new S3Origin(cloudfrontArtifactBucket, {
          originAccessIdentity: originAccessIdentity,
          originPath: "/app1",
        }),
        viewerProtocolPolicy: ViewerProtocolPolicy.REDIRECT_TO_HTTPS,
        compress: true,
      },
      comment: "app1", // Used for identifying the distribution, should match the originPath and zip file name.
    });

    // Deploy the cloudfront-updater Lambda function
    // This Lambda handles S3 events and CloudFront invalidations.
    const cloudfrontUpdater = new NodejsFunction(this, "cloudfront-updater", {
      functionName: "cloudfront-updater",
      runtime: Runtime.NODEJS_18_X,
      entry: resolve(__dirname, "../lambda/cloudfront-updater/index.ts"),
      handler: "index.handler",
      memorySize: 1024,
      environment: {},
      bundling: {
        minify: true,
        sourceMap: true,
        sourceMapMode: SourceMapMode.DEFAULT,
        sourcesContent: true,
        target: "node18",
        externalModules: ["@aws-sdk/client-s3", "@aws-sdk/client-cloudfront"],
      },
    });

    // Attach an inline policy to the Lambda role
    // Allows the Lambda to list distributions and create invalidations.
    cloudfrontUpdater.role?.attachInlinePolicy(
      new Policy(this, "lambda-updater-policy", {
        statements: [
          new PolicyStatement({
            actions: [
              "cloudfront:ListDistributions", // Allow listing all CloudFront distributions.
              "cloudfront:CreateInvalidation", // Allow cache invalidation requests.
            ],
            resources: ["*"], // Permissions apply to all resources.
          }),
        ],
      })
    );

    // Grant the Lambda read/write access to the S3 bucket.
    cloudfrontArtifactBucket.grantReadWrite(cloudfrontUpdater);

    // Set up an S3 event notification to trigger the Lambda
    // Triggers only on the creation of .zip files in the "zip/" directory.
    cloudfrontArtifactBucket.addEventNotification(
      EventType.OBJECT_CREATED,
      new LambdaDestination(cloudfrontUpdater),
      { suffix: ".zip", prefix: "zip/" }
    );
  }
}
