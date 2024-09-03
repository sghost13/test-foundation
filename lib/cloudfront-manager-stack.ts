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

// Cloudfront Manager Stack
// This stack's purpose is to deploy *all* CloudFront distributions

export class CloudfrontManagerStack extends Stack {
  constructor(scope: Construct, id: string, props?: StackProps) {
    super(scope, id, props);

    // S3 bucket to hold CloudFront artifacts as well as app code artifacts for cloudfront to serve
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

    // Create an Origin Access Identity (OAI) for CloudFront
    const originAccessIdentity = new OriginAccessIdentity(
      this,
      "cloudfront-updater-oai",
      {
        comment: "OAI for CloudFront updater to access S3",
      }
    );

    // Grant read permissions to CloudFront OAI
    cloudfrontArtifactBucket.addToResourcePolicy(
      new PolicyStatement({
        actions: ["s3:GetObject"], // Allow CloudFront to get objects from the bucket
        resources: [cloudfrontArtifactBucket.arnForObjects("*")],
        principals: [
          new CanonicalUserPrincipal(
            originAccessIdentity.cloudFrontOriginAccessIdentityS3CanonicalUserId
          ),
        ],
      })
    );

    // Create CloudFront distribution with OAI
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
      comment: "app1", // Needs to match the originPath and zip file name for the cloudfront-updater lambda to work
    });

    // Deploy the cloudfront-updater Lambda
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

    // Grant permissions needed by the cloudfront-updater Lambda
    cloudfrontUpdater.role?.attachInlinePolicy(
      new Policy(this, "lambda-updater-policy", {
        statements: [
          new PolicyStatement({
            actions: [
              "cloudfront:ListDistributions", // Allow listing all distributions
              "cloudfront:CreateInvalidation", // Allow creating cache invalidations
            ],
            resources: ["*"],
          }),
        ],
      })
    );

    // Grant read/write access to the cloudfront-updater Lambda
    cloudfrontArtifactBucket.grantReadWrite(cloudfrontUpdater);

    // S3 event notification to trigger the cloudfront-updater Lambda
    cloudfrontArtifactBucket.addEventNotification(
      EventType.OBJECT_CREATED,
      new LambdaDestination(cloudfrontUpdater),
      { suffix: ".zip", prefix: "zip/" } // Trigger only for .zip files in the "zip/" folder
    );
  }
}
