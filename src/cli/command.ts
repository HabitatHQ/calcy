// Stricli command: read a text file as a calcy workbook, evaluate it with the
// engine, and print the results in the requested table format.

import { readFileSync, writeFileSync } from 'node:fs';
import {
  buildApplication,
  buildChoiceParser,
  buildCommand,
  type CommandContext,
  numberParser
} from '@stricli/core';
import { DEFAULT_OPTIONS, Engine, type EngineOptions, type NumberFormat } from '../lib/engine';
import { OUTPUT_FORMATS, type OutputFormat, render } from './render';

const NUMBER_FORMATS = ['auto', 'compact', 'scientific', 'newspaper'] as const;

export type LocalContext = CommandContext;

interface Flags {
  format?: OutputFormat;
  output?: string;
  samples: number;
  seed: number;
  confidence: number;
  numberFormat: NumberFormat;
}

async function evalWorkbook(
  this: LocalContext,
  flags: Flags,
  file: string
): Promise<Error | undefined> {
  let source: string;
  try {
    // fd 0 is stdin, so `-` pipes a workbook in without a temp file.
    source = readFileSync(file === '-' ? 0 : file, 'utf8');
  } catch (err) {
    const where = file === '-' ? '<stdin>' : file;
    return new Error(`Cannot read ${where}: ${err instanceof Error ? err.message : String(err)}`);
  }

  const opts: Partial<EngineOptions> = {
    N: flags.samples,
    seed: flags.seed,
    confidence: flags.confidence,
    numberFormat: flags.numberFormat
  };
  const result = new Engine(opts).evalSheet(source);

  // A boxed table is friendly on a terminal but noisy in a pipe; Markdown is
  // the clean piped default. An explicit --format always wins.
  const format: OutputFormat = flags.format ?? (globalThis.process.stdout.isTTY ? 'table' : 'md');
  const out = render(result, format);

  if (flags.output) {
    writeFileSync(flags.output, out.endsWith('\n') ? out : `${out}\n`);
  } else {
    this.process.stdout.write(`${out}\n`);
  }
}

const command = buildCommand<Flags, [string], LocalContext>({
  docs: {
    brief: 'Evaluate a calcy workbook file and print its results as a table.'
  },
  parameters: {
    positional: {
      kind: 'tuple',
      parameters: [
        {
          brief: 'Workbook file to evaluate (use "-" to read stdin)',
          parse: String,
          placeholder: 'file'
        }
      ]
    },
    flags: {
      format: {
        kind: 'parsed',
        parse: buildChoiceParser(OUTPUT_FORMATS),
        brief: 'Output format (default: table on a TTY, md when piped)',
        optional: true
      },
      output: {
        kind: 'parsed',
        parse: String,
        brief: 'Write output to this file instead of stdout',
        optional: true
      },
      samples: {
        kind: 'parsed',
        parse: numberParser,
        brief: 'Monte Carlo sample count',
        default: String(DEFAULT_OPTIONS.N)
      },
      seed: {
        kind: 'parsed',
        parse: numberParser,
        brief: 'RNG seed for reproducible sampling',
        default: String(DEFAULT_OPTIONS.seed)
      },
      confidence: {
        kind: 'parsed',
        parse: numberParser,
        brief: 'Confidence level in (0, 1) for interval syntax',
        default: String(DEFAULT_OPTIONS.confidence)
      },
      numberFormat: {
        kind: 'parsed',
        parse: buildChoiceParser(NUMBER_FORMATS),
        brief: 'Number formatting style',
        default: 'auto'
      }
    },
    aliases: {
      f: 'format',
      o: 'output',
      N: 'samples',
      s: 'seed',
      c: 'confidence'
    }
  },
  func: evalWorkbook
});

export const app = buildApplication(command, {
  name: 'calcy',
  // Accept and display multi-word flags in kebab-case (`--number-format`) while
  // the parameter key stays camelCase (`numberFormat`).
  scanner: { caseStyle: 'allow-kebab-for-camel' },
  documentation: { caseStyle: 'convert-camel-to-kebab' }
});
