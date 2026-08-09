const fs = require("fs");
const path = require("path");
const childProcess = require("child_process");
const readline = require("readline");

const rl = readline.createInterface({
  input: process.stdin,
  output: process.stdout,
  prompt: "$ ",
});

const builtins = new Set(["echo", "exit", "type", "pwd", "cd"]);

function parseCommandLine(line) {
  const args = [];
  let current = "";
  let quoteChar = null;
  let argStarted = false;
  let escapeNext = false;

  for (let i = 0; i < line.length; i += 1) {
    const char = line[i];

    if (escapeNext) {
      current += char;
      argStarted = true;
      escapeNext = false;
      continue;
    }

    if (!quoteChar && char === "\\") {
      escapeNext = true;
      continue;
    }

    if (quoteChar) {
      if (quoteChar === '"' && char === "\\") {
        const nextChar = line[i + 1];
        if (nextChar === '"' || nextChar === "\\") {
          current += nextChar;
          i += 1;
          argStarted = true;
          continue;
        }
        current += char;
        argStarted = true;
        continue;
      }

      if (char === quoteChar) {
        quoteChar = null;
      } else {
        current += char;
      }
      continue;
    }

    if (char === "'" || char === '"') {
      quoteChar = char;
      argStarted = true;
      continue;
    }

    if (char === " " || char === "\t") {
      if (argStarted) {
        args.push(current);
        current = "";
        argStarted = false;
      }
      continue;
    }

    current += char;
    argStarted = true;
  }

  if (argStarted || current.length > 0) {
    args.push(current);
  }

  return args;
}

function findExecutable(command) {
  const pathDirs = process.env.PATH ? process.env.PATH.split(path.delimiter) : [];
  for (const dir of pathDirs) {
    if (!dir) {
      continue;
    }

    const candidate = path.join(dir, command);
    try {
      fs.accessSync(candidate, fs.constants.F_OK | fs.constants.X_OK);
      return candidate;
    } catch (err) {
      // File missing or not executable; continue searching.
    }
  }
  return null;
}

rl.prompt();

rl.on("line", (line) => {
  const trimmed = line.trim();
  if (trimmed.length === 0) {
    rl.prompt();
    return;
  }

  const parts = parseCommandLine(line);
  const cmd = parts[0];
  const args = parts.slice(1);

  if (cmd === "exit") {
    rl.close();
    process.exit(0);
  }

  if (cmd === "echo") {
    console.log(args.join(" "));
    rl.prompt();
    return;
  }

  if (cmd === "pwd") {
    console.log(process.cwd());
    rl.prompt();
    return;
  }

  if (cmd === "cd") {
    if (args.length > 0) {
      const dir = args[0];
      let targetDir;
      if (dir === "~") {
        targetDir = process.env.HOME || dir;
      } else if (dir.startsWith("/")) {
        targetDir = dir;
      } else {
        targetDir = path.resolve(process.cwd(), dir);
      }
      try {
        fs.accessSync(targetDir, fs.constants.F_OK);
        const stat = fs.statSync(targetDir);
        if (stat.isDirectory()) {
          process.chdir(targetDir);
        } else {
          console.log(`cd: ${dir}: No such file or directory`);
        }
      } catch (err) {
        console.log(`cd: ${dir}: No such file or directory`);
      }
    }
    rl.prompt();
    return;
  }

  if (cmd === "type") {
    if (args.length > 0) {
      const target = args[0];
      if (builtins.has(target)) {
        console.log(`${target} is a shell builtin`);
      } else {
        const resolved = findExecutable(target);
        if (resolved) {
          console.log(`${target} is ${resolved}`);
        } else {
          console.log(`${target}: not found`);
        }
      }
    }
    rl.prompt();
    return;
  }

  const resolved = findExecutable(cmd);
  if (resolved) {
    const child = childProcess.spawn(resolved, args, { stdio: "inherit", argv0: cmd });
    child.on("close", () => {
      rl.prompt();
    });
    child.on("error", () => {
      console.log(`${cmd}: command not found`);
      rl.prompt();
    });
    return;
  }

  console.log(`${cmd}: command not found`);
  rl.prompt();
});
