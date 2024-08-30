#!/usr/bin/env node
import "source-map-support/register";
import { LambdaManagerStack } from "../lib/lambda-manager-stack";
import { CloudfrontManagerStack } from "../lib/cloudfront-manager-stack";
import { App } from "aws-cdk-lib";

const app = new App();

new LambdaManagerStack(app, "lambda-manager-stack", {});

new CloudfrontManagerStack(app, "cloudfront-manager-stack", {});
