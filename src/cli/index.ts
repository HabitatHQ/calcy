#!/usr/bin/env -S tsx
// Bin entry: evaluate a calcy workbook file from the command line.
// Run directly (`./src/cli/index.ts`) or via `pnpm cli <file>`.

import { run } from '@stricli/core';
import { app } from './command';

await run(app, process.argv.slice(2), { process });
