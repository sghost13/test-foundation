import {
  S3Client,
  GetObjectCommand,
  GetObjectCommandInput,
} from "@aws-sdk/client-s3";
import {
  LambdaClient,
  UpdateFunctionCodeCommand,
  UpdateFunctionCodeCommandInput,
} from "@aws-sdk/client-lambda";
import { Readable } from "stream";
import { Buffer } from "buffer";

const region = process.env.AWS_REGION; // Centralize region configuration
const s3Client = new S3Client({ region });
const lambdaClient = new LambdaClient({ region });

// Utility function to convert a readable stream to a buffer
const streamToBuffer = async (stream: Readable): Promise<Buffer> => {
  const chunks: Buffer[] = [];
  for await (const chunk of stream) {
    chunks.push(Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk));
  }
  return Buffer.concat(chunks);
};

export const handler = async (event: {
  Records: { s3: { bucket: { name: string }; object: { key: string } } }[];
}): Promise<{ statusCode: number; body: string }> => {
  if (!event?.Records?.[0]?.s3) {
    return {
      statusCode: 400,
      body: `Invalid event structure: No S3 records found.`,
    };
  }

  for (const record of event.Records) {
    const bucket: string = record?.s3?.bucket?.name;
    const key: string = record?.s3?.object?.key;

    if (!bucket || !key) {
      return {
        statusCode: 400,
        body: `Invalid event structure: Bucket name or key is missing.`,
      };
    }

    try {
      // Get the object from S3
      const downloadParams: GetObjectCommandInput = {
        Bucket: bucket,
        Key: key,
      };

      const { Body } = await s3Client.send(
        new GetObjectCommand(downloadParams)
      );

      // Convert the stream to a buffer
      const lambdaZip = await streamToBuffer(Body as Readable);

      // Deploy the Lambda function code update
      const functionName = key.split("/").pop()?.split(".")[0]; // Handle paths
      if (!functionName) {
        throw new Error("Unable to extract function name from key.");
      }

      const updateParams: UpdateFunctionCodeCommandInput = {
        FunctionName: functionName,
        ZipFile: lambdaZip,
      };

      await lambdaClient.send(new UpdateFunctionCodeCommand(updateParams));

      console.log(`Lambda function ${functionName} updated successfully.`);
    } catch (err) {
      if (err instanceof Error) {
        // Narrow down 'err' type
        if (err.name === "NoSuchBucket" || err.name === "NoSuchKey") {
          console.error("S3 Error:", err);
        } else {
          console.error("Lambda Update Error:", err);
        }
        return {
          statusCode: 500,
          body: `Failed to update Lambda function: ${err.message}`,
        };
      } else {
        // Handle cases where the error is not an instance of Error
        console.error("Unknown error:", err);
        return {
          statusCode: 500,
          body: `Failed to update Lambda function due to an unknown error.`,
        };
      }
    }
  }

  return {
    statusCode: 200,
    body: `Lambda function(s) updated successfully.`,
  };
};
