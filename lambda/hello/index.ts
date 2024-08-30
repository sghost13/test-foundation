import { Handler } from "aws-lambda";

// This hello lambda only exists only to show how to deploy a lambda function using the esbuild config
// See the esbuild.config.ts file for more details
// See the actions workflow for more details

// Handler function
export const handler: Handler = async (
  event: any
): Promise<{ message: string }> => {
  return {
    message: "Hello, Hightower!",
  };
};
