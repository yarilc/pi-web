/**
 * Pi extension entry point.
 *
 * Thin re-export of the factory in src/index.ts. Lives at the package root so
 * Pi labels the extension "pi-web" in its startup summary (`[Extensions]`):
 * Pi derives the display name for local-path extensions from the entry
 * point's path segments — a root-level index.ts yields segments
 * ["pi-web", "index.ts"], the trailing "index.ts" is stripped, and the
 * shortest unique suffix is "pi-web". An entry point at ./src/index.ts
 * would instead be displayed as "src".
 *
 * The actual factory and tool registration live in src/.
 */
export { default } from "./src/index.ts";
