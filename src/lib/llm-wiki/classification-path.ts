import { relativePath } from "./filesystem";

export function classificationPath(value: unknown): string {
  const category = relativePath(value);
  if (category.length > 240 || category.split("/").length > 6 || category.split("/").some((part) =>
    part.startsWith(".") || ["manifest.yaml", "node_modules", "assets", "build", "dist"].includes(part.toLowerCase()))) {
    throw new Error("Invalid classification category");
  }
  return category;
}
