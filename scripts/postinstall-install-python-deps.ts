#!/usr/bin/env bun

/**
 * Check whether the Python training environment is available after install.
 */

import { execSync } from 'child_process';
import { existsSync } from 'fs';
import { join } from 'path';

function checkPythonInstalled(): boolean {
  try {
    execSync('python3 --version', { stdio: 'ignore' });
    return true;
  } catch {
    try {
      execSync('python --version', { stdio: 'ignore' });
      return true;
    } catch {
      return false;
    }
  }
}

function checkTrainingEnvironment(): void {
  const trainingPath = join(process.cwd(), 'packages/training/python');
  if (!existsSync(trainingPath)) {
    console.log('   ⏭️  Training Pipeline directory not found, skipping');
    return;
  }

  // Check if pyproject.toml or requirements.txt exists
  const hasPyproject = existsSync(join(trainingPath, 'pyproject.toml'));
  const hasRequirements = existsSync(join(trainingPath, 'requirements.txt'));

  if (!hasPyproject && !hasRequirements) {
    console.log('   ⏭️  Training Pipeline has no Python config, skipping');
    return;
  }

  if (existsSync(join(trainingPath, 'venv'))) {
    console.log(
      '   ✅ Training Pipeline: venv already exists, skipping install'
    );
    console.log(
      `   💡 To reinstall: cd ${trainingPath} && pip install -r requirements.txt`
    );
    return;
  }

  console.log('   ⏭️  Training Pipeline: No venv found');
  console.log(
    `   💡 To set up: cd ${trainingPath} && python3 -m venv venv && source venv/bin/activate && pip install -r requirements.txt`
  );
}

function checkPythonDependencies(): void {
  console.log('🐍 Checking Python dependencies...');

  if (!checkPythonInstalled()) {
    console.log('   ⚠️  Python not found, skipping Python dependency checks');
    console.log('   💡 Install Python 3.11+ to use Python projects');
    return;
  }

  checkTrainingEnvironment();
  console.log('   ✅ Python dependency check complete');
}

try {
  checkPythonDependencies();
} catch (error) {
  console.error('Error checking Python dependencies:', error);
  process.exit(1);
}
