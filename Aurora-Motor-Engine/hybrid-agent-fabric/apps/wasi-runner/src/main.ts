#!/usr/bin/env node
import { WASI } from "node:wasi";
import { readFile } from "node:fs/promises";
import { resolve } from "node:path";

const [modulePath, pluginDirectory, scratchDirectory] = process.argv.slice(2);
if (!modulePath || !pluginDirectory || !scratchDirectory) throw new Error("Usage: wasi-runner <module.wasm> <plugin-dir> <scratch-dir>");
const wasi = new WASI({
  version: "preview1",
  args: ["plugin.wasm", process.env.HAF_PLUGIN_ACTION ?? "invoke"],
  env: {
    HAF_PLUGIN_ACTION: process.env.HAF_PLUGIN_ACTION ?? "invoke",
    HAF_PLUGIN_ID: process.env.HAF_PLUGIN_ID ?? "unknown",
  },
  preopens: {
    "/plugin": resolve(pluginDirectory),
    "/scratch": resolve(scratchDirectory),
  },
  returnOnExit: true,
});
const module = await WebAssembly.compile(await readFile(resolve(modulePath)));
const instance = await WebAssembly.instantiate(module, { wasi_snapshot_preview1: wasi.wasiImport });
const exitCode = wasi.start(instance as WebAssembly.Instance & { exports: { _start: () => unknown } });
process.exitCode = exitCode;
