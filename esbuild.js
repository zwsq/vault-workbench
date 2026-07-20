const esbuild = require("esbuild");

const production = process.argv.includes("--production");
const watch = process.argv.includes("--watch");

async function main() {
  const ctx = await esbuild.context({
    entryPoints: ["src/extension.ts"],
    bundle: true,
    format: "cjs",
    minify: production,
    sourcemap: !production,
    sourcesContent: false,
    platform: "node",
    target: "node18",
    outfile: "dist/extension.js",
    external: ["vscode"],
    logLevel: "silent",
    plugins: [problemMatcherPlugin]
  });
  if (watch) {
    await ctx.watch();
  } else {
    await ctx.rebuild();
    await ctx.dispose();
  }
}

const problemMatcherPlugin = {
  name: "problem-matcher",
  setup(build) {
    build.onStart(() => console.log("[build] started"));
    build.onEnd((result) => {
      result.errors.forEach(({ text, location }) => {
        console.error(`\u2716 [ERROR] ${text}`);
        if (location) {
          console.error(`    ${location.file}:${location.line}:${location.column}`);
        }
      });
      console.log("[build] finished");
    });
  }
};

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
