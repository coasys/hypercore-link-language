import * as esbuild from "https://deno.land/x/esbuild@v0.17.18/mod.js";
import { denoPlugins } from "https://deno.land/x/esbuild_deno_loader@0.7.0/mod.ts";
import { resolve } from "https://deno.land/std@0.177.0/path/mod.ts";

// Resolve `@coasys/ad4m-ldk` to its compiled lib in the workspace.
const ad4mLdkEntry = process.env.AD4M_LDK_ENTRY || "../ad4m/ad4m-ldk/js/lib/index.js";

// Project root — only resolve .js→.ts within our own source tree
const projectRoot = new URL(".", import.meta.url).pathname.replace(/\/$/, "");

const ad4mLdkAliasPlugin = {
  name: "ad4m-ldk-alias",
  setup(build: any) {
    // Mark ad4m:host as external — resolved at runtime by the executor
    build.onResolve({ filter: /^ad4m:host$/ }, () => ({
      path: "ad4m:host",
      external: true,
    }));
    // Resolve @coasys/ad4m-ldk to the local workspace build
    build.onResolve({ filter: /^@coasys\/ad4m-ldk$/ }, () => ({
      path: ad4mLdkEntry,
      namespace: "file",
    }));
  },
};

// Plugin to resolve .js imports to .ts source files, but ONLY within
// our project directory. The ALDK lib/ ships compiled .js and must
// resolve as-is.
const tsResolverPlugin = {
  name: "ts-resolver",
  setup(build: any) {
    build.onResolve({ filter: /\.js$/ }, (args: any) => {
      if (args.namespace !== "file" || !args.path.startsWith(".")) return;
      // Only rewrite within our project tree
      const resolveDir = args.resolveDir || ".";
      if (!resolveDir.startsWith(projectRoot)) return;
      const tsPath = args.path.replace(/\.js$/, ".ts");
      const resolved = resolve(resolveDir, tsPath);
      return { path: resolved, namespace: "file" };
    });
  },
};

const result = await esbuild.build({
  plugins: [
    ad4mLdkAliasPlugin,
    tsResolverPlugin,
    ...denoPlugins(),
  ],
  entryPoints: ["index.ts"],
  outfile: "build/bundle.js",
  bundle: true,
  platform: "node",
  target: "deno1.32.4",
  format: "esm",
  globalName: "hypercore.link.language",
  charset: "ascii",
  legalComments: "inline",
});

console.log("Build result:", result);

esbuild.stop();
