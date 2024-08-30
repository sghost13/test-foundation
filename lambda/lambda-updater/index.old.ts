import { S3Client, GetObjectCommand } from "@aws-sdk/client-s3";
import {
  LambdaClient,
  UpdateFunctionCodeCommand,
} from "@aws-sdk/client-lambda";
import { readFileSync, createWriteStream } from "fs";
import { pipeline } from "stream";
import { promisify } from "util";

// lambdaUpdater Lambda

// Automates the process of updating the *code* of a lambda function, ie the zip artifact
// Gets an event trigger from the lambda artifact bucket, grabs the zip artifact, and updates the associated lambda functions code

// esbuild config not needed for this lambda, it will get bundled when deployed through cdk
// It will only ever be deployed by cdk, and will not live in the lambda-artifact-bucket
// This lambda is part of the foundation, it is ci cd code

const s3Client = new S3Client({ region: process.env.AWS_REGION });
const lambdaClient = new LambdaClient({ region: process.env.AWS_REGION });

const pipe = promisify(pipeline);

export const handler = async (
  event: any
): Promise<{ statusCode: number; body: string }> => {
  const bucket: string = event.Records[0].s3.bucket.name;
  const key: string = event.Records[0].s3.object.key;

  try {
    // Get the object from S3
    const downloadParams = {
      Bucket: bucket,
      Key: key,
    };

    const { Body } = await s3Client.send(new GetObjectCommand(downloadParams));

    const filePath = `/tmp/${key}`;
    await pipe(Body as NodeJS.ReadableStream, createWriteStream(filePath));

    // Read the zip file (Assuming the file is a zipped Lambda function)
    const lambdaZip = readFileSync(filePath);

    // Deploy the Lambda function code update
    const functionName = key.split(".")[0]; // Assuming file name is the Lambda function name
    const updateParams = {
      FunctionName: functionName,
      ZipFile: lambdaZip,
    };

    await lambdaClient.send(new UpdateFunctionCodeCommand(updateParams));

    return {
      statusCode: 200,
      body: `Lambda function ${functionName} updated successfully.`,
    };
  } catch (err) {
    console.error(`Error updating Lambda function:`, err);
    return {
      statusCode: 500,
      body: `Failed to update Lambda function: ${(err as Error).message}`,
    };
  }
};
