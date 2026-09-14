#!/usr/bin/env node
import { main } from '../dist/cli/main.js';

process.exitCode = await main(process.argv.slice(2));
