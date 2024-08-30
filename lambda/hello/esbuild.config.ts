import { build } from "esbuild";
import * as path from "path";

// Example esbuild config for the 'hello' lambda
// This config directly relates to configuration in a NodejsFunction deploy in cdk. cdk uses esbuild behind the scenes

build({
  entryPoints: [path.join(__dirname, "index.ts")], // Entry point to your Lambda function, relative to the esbuild.config.ts file
  bundle: true, // Bundle all dependencies into the output
  platform: "node", // Target platform is Node.js
  target: "node18", // Target Node.js version
  outdir: path.join(__dirname, "dist"), // Output directory for the bundled files, relative to the esbuild config file
  sourcemap: true, // Generate source maps for debugging
  minify: true, // Minify the output for smaller deployment size
  external: [], // Optional: Specify external dependencies to -exclude- from the bundle, ie libraries loaded from lambda layers
}).catch(() => process.exit(1));
