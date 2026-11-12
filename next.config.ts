import type { NextConfig } from "next";
const config: NextConfig = {
  poweredByHeader: false,
  devIndicators: false,
  serverExternalPackages: ["@huggingface/transformers", "onnxruntime-node"],
};
export default config;
