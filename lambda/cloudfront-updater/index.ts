import {
  S3Client,
  GetObjectCommand,
  PutObjectCommand,
  ListObjectsV2Command,
  DeleteObjectsCommand,
  GetObjectCommandOutput,
} from "@aws-sdk/client-s3";
import {
  CloudFrontClient,
  CreateInvalidationCommand,
  ListDistributionsCommand,
} from "@aws-sdk/client-cloudfront";
import { S3Event, Context } from "aws-lambda";
import { Readable } from "stream";
import { Parse } from "unzipper";
import { lookup } from "mime-types";

const region = process.env.AWS_REGION;
const s3Client = new S3Client({ region });
const cloudFrontClient = new CloudFrontClient({ region });

/**
 * AWS Lambda handler function for processing S3 events related to CloudFront updates.
 *
 * This function is triggered by an S3 event whenever a new object is uploaded to the specified bucket.
 * It processes zip files uploaded to the "zip/" directory, extracts their contents, and uploads them
 * to the corresponding destination in the S3 bucket. Finally, it invalidates the CloudFront distribution
 * associated with the updated content.
 *
 * @param {S3Event} event - The S3 event triggering the Lambda function, containing details of the S3 object.
 * @param {Context} context - The AWS Lambda execution context.
 * @returns {Promise<void>} A promise that resolves when the processing is complete.
 * @throws {Error} If there is an error during processing, the function will log and throw an error.
 */
export const handler = async (
  event: S3Event,
  context: Context
): Promise<void> => {
  console.log("CloudFront Updater Lambda started processing S3 event.");

  // Declare bucketName and decodedObjectKey outside the try block
  let bucketName: string | undefined;
  let decodedObjectKey: string | undefined;

  try {
    // Retrieve the bucket name and object key from the S3 event record
    bucketName = event.Records[0].s3.bucket.name;
    const encodedObjectKey = event.Records[0].s3.object.key;
    decodedObjectKey = decodeURIComponent(encodedObjectKey); // Decode the object key

    console.log(
      `Processing object from bucket: ${bucketName}, key: ${decodedObjectKey}`
    );

    // Skip processing if the object is not in the "zip/" directory
    if (!decodedObjectKey.startsWith("zip/")) {
      console.log(
        "The object is not in the zip directory. Skipping processing."
      );
      return;
    }

    // Determine the destination path by removing "zip/" and ".zip" from the object key
    const destinationPath = decodedObjectKey
      .replace(/^zip\//, "")
      .replace(/\.zip$/, "");

    console.log(`Extracting contents to path: ${destinationPath}`);

    // Extract the contents of the zip file and upload them to the destination path in the S3 bucket
    await extractAndUploadZipFile(
      bucketName,
      decodedObjectKey,
      destinationPath
    );

    // Extract the distribution name from the destination path
    const distributionName = destinationPath.split("/")[0];
    // Get the CloudFront distribution ID using the distribution name
    const distributionId = await getDistributionIdByName(distributionName);

    // Invalidate the CloudFront distribution to ensure the updated content is served
    await invalidateCloudFront(distributionId);

    console.log(
      `Successfully processed and uploaded contents from S3: ${bucketName}/${decodedObjectKey}`
    );
  } catch (error) {
    console.error(
      `Error processing S3 event for bucket: ${bucketName}, key: ${decodedObjectKey}`,
      error
    );
    throw new Error("Error processing S3 event"); // Throw an error to indicate failure
  }
};

/**
 * Extracts a ZIP file from an S3 bucket and uploads its contents to a specified destination path in the same or another S3 bucket.
 *
 * @param {string} bucketName - The name of the S3 bucket containing the ZIP file.
 * @param {string} decodedObjectKey - The key of the ZIP file object in the S3 bucket.
 * @param {string} destinationPath - The S3 path where the extracted contents should be uploaded.
 * @returns {Promise<void>} A promise that resolves when the extraction and upload process is complete.
 */
const extractAndUploadZipFile = async (
  bucketName: string,
  decodedObjectKey: string,
  destinationPath: string
): Promise<void> => {
  // First, delete any existing objects at the destination path to ensure a clean upload
  await deleteS3ObjectsAtPath(bucketName, destinationPath);

  // Fetch the S3 object stream for the ZIP file
  const s3Object = await fetchS3ObjectStream(bucketName, decodedObjectKey);

  // Check if the S3 object has a valid Body stream; if not, log a message and exit
  if (!s3Object.Body) {
    console.warn(
      `No readable stream found in object ${decodedObjectKey}. Skipping processing.`
    );
    return;
  }

  // Extract the ZIP file's contents from the stream and upload them to the destination path
  await extractAndUploadFromStream(s3Object.Body, bucketName, destinationPath);
};

/**
 * Fetches an object from S3 as a readable stream.
 *
 * @param {string} bucketName - The name of the S3 bucket.
 * @param {string} decodedObjectKey - The key of the object in the S3 bucket, after decoding.
 * @returns {Promise<{ Body: Readable | null }>} - A promise that resolves to an object containing the readable stream of the S3 object, or null if the body is not a readable stream.
 */
const fetchS3ObjectStream = async (
  bucketName: string,
  decodedObjectKey: string
): Promise<{ Body: Readable | null }> => {
  // Define parameters required for the GetObjectCommand
  const getObjectParams = {
    Bucket: bucketName, // S3 bucket name
    Key: decodedObjectKey, // S3 object key
  };

  // Send the GetObjectCommand to S3 and wait for the response
  const getObjectOutput: GetObjectCommandOutput = await s3Client.send(
    new GetObjectCommand(getObjectParams)
  );

  // Extract the Body from the response, which could be a stream or undefined
  const bodyStream = getObjectOutput.Body;

  // Check if the Body is a readable stream; if not, return null
  if (bodyStream instanceof Readable) {
    return { Body: bodyStream };
  } else {
    console.warn(
      `Body is not a readable stream or is undefined for object: ${decodedObjectKey}`
    );
    return { Body: null };
  }
};

/**
 * Extracts files from a zip stream and uploads them to the specified S3 bucket.
 *
 * @param {Readable} bodyStream - The readable stream of the zip file to be extracted.
 * @param {string} bucketName - The name of the S3 bucket where files will be uploaded.
 * @param {string} destinationPath - The destination path within the S3 bucket where files will be uploaded.
 * @returns {Promise<void>} - A promise that resolves when the extraction and upload process is complete.
 */
const extractAndUploadFromStream = async (
  bodyStream: Readable,
  bucketName: string,
  destinationPath: string
): Promise<void> => {
  // Pipe the incoming stream through the unzip parser
  const unzipStream = bodyStream.pipe(Parse());
  let isEmpty = true;
  console.log("Started unzipping and uploading process.");

  await new Promise<void>((resolve, reject) => {
    unzipStream.on("entry", async (entry) => {
      try {
        // Process each entry in the zip file
        await handleZipEntry(entry, bucketName, destinationPath);
        isEmpty = false;
      } catch (error) {
        // Log and reject if there is an error processing any entry
        console.error(`Error processing zip entry ${entry.path}:`, error);
        reject(error);
      }
    });

    unzipStream.on("finish", () => {
      // Log whether the zip file was empty or all files were processed
      if (isEmpty) {
        console.log("Zip file is empty, no files to upload.");
      } else {
        console.log("Finished unzipping and uploading all files.");
      }
      resolve();
    });

    unzipStream.on("error", (error) => {
      // Handle and log any errors that occur during the unzip process
      console.error("Error during unzip process:", error);
      reject(error);
    });
  });
};

/**
 * Handles a zip entry by processing it based on its type and uploading it to S3 if it is a file.
 *
 * @param {Object} entry - The entry object from the zip file.
 * @param {string} entry.path - The path of the entry within the zip file.
 * @param {string} entry.type - The type of the entry (e.g., "File", "Directory").
 * @param {string} bucketName - The name of the S3 bucket where the file should be uploaded.
 * @param {string} destinationPath - The destination path in the S3 bucket where the file should be uploaded.
 *
 * @returns {Promise<void>} - A promise that resolves when the entry is processed.
 *
 * @throws Will throw an error if the file upload to S3 fails.
 */
const handleZipEntry = async (
  entry: any,
  bucketName: string,
  destinationPath: string
): Promise<void> => {
  const filePath = entry.path; // Path of the entry within the zip file
  const fileType = entry.type; // Type of the entry (e.g., "File" or "Directory")

  console.log(`Processing ${fileType}: ${filePath}`);

  if (fileType === "File") {
    try {
      // Attempt to upload the file to S3
      await uploadFileToS3(entry, bucketName, filePath, destinationPath);
    } catch (uploadError) {
      console.error(
        `Error uploading file ${filePath} to ${destinationPath} in bucket ${bucketName}`,
        uploadError
      );
      entry.autodrain(); // Drain the entry stream to prevent backpressure
      throw uploadError; // Re-throw the error to handle it in the unzip stream
    }
  } else {
    entry.autodrain(); // Drain directory entries as they are not being uploaded
    console.log(`Skipped directory: ${filePath}`);
  }
};

/**
 * Uploads a file to an S3 bucket.
 *
 * @param {any} entry - The file content to upload.
 * @param {string} bucketName - The name of the S3 bucket.
 * @param {string} filePath - The file path within the zip or local file system.
 * @param {string} destinationPath - The destination path within the S3 bucket.
 * @returns {Promise<void>} - A promise that resolves when the upload is complete.
 */
const uploadFileToS3 = async (
  entry: any,
  bucketName: string,
  filePath: string,
  destinationPath: string
): Promise<void> => {
  // Determine the content type based on the file extension, defaulting to 'application/octet-stream'
  const contentType = lookup(filePath) || "application/octet-stream";

  // Adjust the file path to be relative within the zip structure, stripping out leading directories
  const relativeFilePathWithinZip = filePath
    .replace(/^zip\//, "") // Remove 'zip/' prefix if it exists
    .replace(/^.*?\//, ""); // Remove the first directory in the path

  // Construct the final S3 key by appending the relative file path to the destination path
  const finalKey = `${destinationPath}/${relativeFilePathWithinZip}`;

  // Prepare the parameters for the S3 upload
  const uploadParams = {
    Bucket: bucketName,
    Key: finalKey, // The S3 object key (path within the bucket)
    Body: entry, // The file content
    ContentType: contentType, // The MIME type of the file
  };

  // Upload the file to S3
  await s3Client.send(new PutObjectCommand(uploadParams));

  // Log the successful upload
  console.log(`Uploaded file ${finalKey} with Content-Type: ${contentType}`);
};

/**
 * Deletes all objects at the specified path in an S3 bucket.
 * The deletion process is handled in batches to accommodate large numbers of objects.
 *
 * @param {string} bucketName - The name of the S3 bucket.
 * @param {string} path - The path within the bucket where objects should be deleted.
 * @returns {Promise<void>} - A promise that resolves when the deletion is complete.
 * @throws {Error} - Throws an error if the deletion fails.
 */
const deleteS3ObjectsAtPath = async (
  bucketName: string,
  path: string
): Promise<void> => {
  try {
    let isTruncated = true;
    let continuationToken: string | undefined;
    let totalDeleted = 0; // Track the total number of deleted objects

    while (isTruncated) {
      const listParams = {
        Bucket: bucketName,
        Prefix: path,
        ContinuationToken: continuationToken, // Token to continue listing if there are more than 1000 objects
      };

      // List objects in the specified S3 path
      const listResponse = await s3Client.send(
        new ListObjectsV2Command(listParams)
      );

      if (listResponse.Contents && listResponse.Contents.length > 0) {
        const deleteBatches = [];

        // Split the listed objects into batches of 1000 for deletion
        for (let i = 0; i < listResponse.Contents.length; i += 1000) {
          const batch = listResponse.Contents.slice(i, i + 1000).map(
            (item) => ({
              Key: item.Key!, // `Key` should always be present if `Contents` is defined
            })
          );
          deleteBatches.push(batch);
        }

        // Delete objects in batches to handle large deletions efficiently
        await Promise.all(
          deleteBatches.map(async (batch) => {
            await s3Client.send(
              new DeleteObjectsCommand({
                Bucket: bucketName,
                Delete: {
                  Objects: batch,
                  Quiet: true, // Suppress the response of the delete operation
                },
              })
            );
            totalDeleted += batch.length; // Increment the totalDeleted counter by the number of objects in the batch
          })
        );
      }

      // Check if there are more objects to delete by checking if the response is truncated
      isTruncated = listResponse.IsTruncated === true;
      continuationToken = listResponse.NextContinuationToken; // Update the continuation token for the next request
    }

    console.log(
      `Deleted ${totalDeleted} objects from S3 bucket: ${bucketName} at path: ${path}/`
    );
  } catch (error) {
    console.error(`Error deleting path from S3 bucket: ${bucketName}`, error);
    throw error; // Re-throw the error after logging it
  }
};

/**
 * Retrieves the CloudFront distribution ID by its name (comment).
 *
 * @param {string} distributionName - The name (comment) of the distribution to search for.
 * @returns {Promise<string>} - A promise that resolves to the distribution ID.
 * @throws Will throw an error if no distributions are found or if the specified distribution name is not found.
 */
export const getDistributionIdByName = async (
  distributionName: string
): Promise<string> => {
  try {
    // Sends a request to list all CloudFront distributions.
    const data = await cloudFrontClient.send(new ListDistributionsCommand({}));

    // Retrieve the list of distributions from the response.
    const distributions = data.DistributionList?.Items;

    // Check if the distribution list is empty or undefined.
    if (!distributions || distributions.length === 0) {
      throw new Error(
        "No distributions found for this AWS account's region or DistributionList is empty."
      );
    }

    // Find the distribution that matches the given name (comment).
    const distribution = distributions.find(
      (d) => d.Comment === distributionName
    );

    // If no matching distribution is found or it doesn't have an ID, throw an error.
    if (!distribution || !distribution.Id) {
      throw new Error(
        `No distribution found with the name: ${distributionName}`
      );
    }

    // Return the distribution ID if found.
    return distribution.Id;
  } catch (err) {
    // Log an error message if there is an issue retrieving the distribution ID.
    console.error(
      `Error retrieving distribution ID for ${distributionName}`,
      err
    );
    // Re-throw the error to be handled by the caller.
    throw err;
  }
};

/**
 * Invalidates the CloudFront distribution cache by creating an invalidation request for all paths (/*).
 *
 * @param {string} distributionId - The ID of the CloudFront distribution to invalidate.
 * @returns {Promise<void>} - A promise that resolves when the invalidation request is successfully created.
 *
 * @throws Will throw an error if the invalidation request fails after retries.
 */
const invalidateCloudFront = async (distributionId: string): Promise<void> => {
  const callerReference = `${Date.now()}`; // Unique identifier for the invalidation request to ensure idempotence.

  const invalidationParams = {
    DistributionId: distributionId, // Specify the CloudFront distribution ID.
    InvalidationBatch: {
      CallerReference: callerReference, // Use the unique caller reference.
      Paths: {
        Quantity: 1, // Invalidate a single path pattern.
        Items: ["/*"], // Invalidate all paths within the distribution.
      },
    },
  };

  // Retry the invalidation in case of transient errors, up to 3 times.
  await retryWithBackoff(async () => {
    try {
      const invalidationResult = await cloudFrontClient.send(
        new CreateInvalidationCommand(invalidationParams) // Send the invalidation request to CloudFront.
      );
      console.log(
        "CloudFront invalidation created with ID:",
        invalidationResult.Invalidation?.Id
      );
    } catch (error) {
      console.error("Error creating CloudFront invalidation:", error);
      throw error; // Re-throw to trigger retry if an error occurs.
    }
  }, 3); // Maximum of 3 retries.
};

/**
 * Retries a given asynchronous function with exponential backoff.
 *
 * @template T - The type of the result returned by the asynchronous function.
 * @param {() => Promise<T>} fn - The asynchronous function to be retried.
 * @param {number} retries - The number of retry attempts.
 * @param {number} [delay=1000] - The initial delay between retries in milliseconds.
 * @returns {Promise<T>} - A promise that resolves with the result of the asynchronous function, or rejects if all retries are exhausted.
 * @throws {Error} - Throws the error from the last attempt if all retries are exhausted.
 */
const retryWithBackoff = async <T>(
  fn: () => Promise<T>,
  retries: number,
  delay: number = 1000
): Promise<T> => {
  let attempt = 0; // Track the current attempt number
  while (retries > 0) {
    try {
      return await fn(); // Try to execute the function
    } catch (error) {
      retries--; // Decrement the number of retries left
      attempt++; // Increment the attempt counter
      if (retries === 0) throw error; // If no retries left, throw the error

      const backoffDelay = delay * Math.pow(2, attempt); // Calculate the exponential backoff delay
      console.warn(
        `Attempt ${attempt} failed. Retrying in ${backoffDelay}ms... (${retries} retries left)`
      );

      await new Promise((resolve) => setTimeout(resolve, backoffDelay)); // Wait for the backoff delay before retrying
    }
  }
  throw new Error("Retries exhausted"); // In case all retries are exhausted
};
