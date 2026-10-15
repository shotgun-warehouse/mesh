// Resolve @shotgunlive/mesh from the TypeScript sources in the parent folder, so the
// example picks up SDK changes without a build step.
const { getDefaultConfig } = require("expo/metro-config");
const path = require("path");

const config = getDefaultConfig(__dirname);
const repoRoot = path.resolve(__dirname, "..");

// Watch the SDK sources too, otherwise edits under ../src are served from a stale cache.
config.watchFolders = [...config.watchFolders, repoRoot];

config.resolver.resolveRequest = (context, moduleName, platform) => {
  if (moduleName === "@shotgunlive/mesh") {
    return {
      type: "sourceFile",
      filePath: path.resolve(__dirname, "..", "src", "index.ts"),
    };
  }
  return context.resolveRequest(context, moduleName, platform);
};

module.exports = config;
