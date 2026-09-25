module.exports = {
  appId: "ai.hybridagentfabric.desktop",
  productName: "Hybrid Agent Fabric",
  directories: { output: "release" },
  files: ["dist/**/*", "package.json"],
  asar: true,
  mac: { target: ["dmg", "zip"], category: "public.app-category.developer-tools", hardenedRuntime: true },
  win: { target: ["nsis", "zip"] },
  linux: { target: ["AppImage", "deb"], category: "Development" },
  publish: null,
};
