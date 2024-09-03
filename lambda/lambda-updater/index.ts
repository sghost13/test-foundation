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
import { S3Event, Context } from "aws-lambda";
import { Readable } from "stream";
import { Buffer } from "buffer";
import { finished } from "stream/promises";

const region = process.env.AWS_REGION;
const s3Client = new S3Client({ region });
const lambdaClient = new LambdaClient({ region });

/**
 * AWS Lambda handler function to process S3 events and update Lambda functions.
 *
 * @param {S3Event} event - The S3 event that triggered the Lambda function.
 * @param {Context} context - The context in which the Lambda function is executed.
 * @returns {Promise<void>} A promise that resolves when the event is fully processed.
 * @throws Will throw an error if there is any issue during the processing of the S3 event.
 */
export const handler = async (
  event: S3Event,
  context: Context
): Promise<void> => {
  console.log("Lambda Updater started processing S3 event.");

  let bucketName: string | undefined;
  let objectKey: string | undefined;

  try {
    // Retrieve the S3 bucket name and object key from the event
    bucketName = event.Records[0].s3.bucket.name;
    objectKey = decodeURIComponent(event.Records[0].s3.object.key);

    if (!objectKey) {
      console.error("Object key is undefined or null.");
      return; // Exit early if the object key is missing
    }

    console.log(
      `Processing object from bucket: ${bucketName}, key: ${objectKey}`
    );

    const getObjectParams: GetObjectCommandInput = {
      Bucket: bucketName, // S3 bucket name
      Key: objectKey, // S3 object key
    };

    // Get the object from S3 and convert the stream to a buffer
    const { Body } = await s3Client.send(new GetObjectCommand(getObjectParams));
    const lambdaCodeBuffer = await convertStreamToBuffer(Body as Readable);

    // Extract the Lambda function name from the object key
    const functionName = objectKey.split("/").pop()?.split(".")[0];
    if (!functionName) {
      console.error("Unable to extract function name from key.");
      return; // Exit early if the function name cannot be determined
    }

    // Update the Lambda function with the new code
    await updateLambdaFunctionCode(functionName, lambdaCodeBuffer);
  } catch (err) {
    if (err instanceof Error) {
      console.error(
        `Error processing S3 event for bucket: ${bucketName}, key: ${objectKey}. Error: ${err.message}`
      );
    } else {
      console.error(
        `Unexpected error processing S3 event for bucket: ${bucketName}, key: ${objectKey}.`
      );
    }
    throw err; // Rethrow the error to ensure the Lambda reports the failure
  }
};

/**
 * Converts a readable stream into a buffer.
 *
 * @param {Readable} stream - The readable stream to be converted.
 * @returns {Promise<Buffer>} A promise that resolves to the buffered content of the stream.
 * @throws Will throw an error if there is an issue converting the stream to a buffer.
 */
const convertStreamToBuffer = async (stream: Readable): Promise<Buffer> => {
  const chunks: Buffer[] = [];
  try {
    for await (const chunk of stream) {
      chunks.push(Buffer.from(chunk)); // Convert each chunk to a Buffer
    }
    await finished(stream); // Ensure the stream is fully consumed and closed
  } catch (error) {
    console.error("Error converting stream to buffer:", error);
    throw error; // Rethrow the error to be handled by the calling function
  }
  return Buffer.concat(chunks); // Combine all chunks into a single Buffer
};

/**
 * Updates the code of a specified Lambda function.
 *
 * @param {string} functionName - The name of the Lambda function to update.
 * @param {Buffer} lambdaCodeBuffer - The new code for the Lambda function as a zipped buffer.
 * @returns {Promise<void>} A promise that resolves when the Lambda function is successfully updated.
 * @throws Will throw an error if there is an issue with updating the Lambda function code.
 */
const updateLambdaFunctionCode = async (
  functionName: string,
  lambdaCodeBuffer: Buffer
): Promise<void> => {
  const updateFunctionCodeParams: UpdateFunctionCodeCommandInput = {
    FunctionName: functionName, // Name of the Lambda function to update
    ZipFile: lambdaCodeBuffer, // Lambda function code as a zipped buffer
  };

  await lambdaClient.send(
    new UpdateFunctionCodeCommand(updateFunctionCodeParams)
  );
  console.log(`Lambda function ${functionName} updated successfully.`);
};
