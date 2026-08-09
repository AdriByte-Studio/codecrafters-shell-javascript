const fs = require("fs");
const path = require("path");
const childProcess = require("child_process");
const readline = require("readline");

const completions = ["echo", "exit"];

function getPathExecutables(prefix) {
  const entries = new Set();
  const pathEnv = process.env.PATH || "";
  const pathDirs = pathEnv.split(path.delimiter);
  for (const dir of pathDirs) {
    if (!dir) {
      continue;
    }
    try {
      const names = fs.readdirSync(dir);
      for (const name of names) {
        if (!name.startsWith(prefix)) {
          continue;
        }
        const candidate = path.join(dir, name);
        try {
          fs.accessSync(candidate, fs.constants.F_OK | fs.constants.X_OK);
          entries.add(name);
        } catch (err) {
          // ignore non-executable or inaccessible files
        }
      }
    } catch (err) {
      // ignore directories that can't be read or don't exist
    }
  }
  return Array.from(entries).sort();
}

let rl;
const completerState = {
  prefix: null,
  count: 0,
};

function completionHandler(line) {
  const trimmed = line.trimStart();
  if (trimmed.includes(" ") || trimmed.length === 0) {
    process.stdout.write("\x07");
    completerState.prefix = null;
    completerState.count = 0;
    return [[], line];
  }

  const hits = completions.filter((cmd) => cmd.startsWith(trimmed));
  const pathHits = getPathExecutables(trimmed);
  const allHits = [...new Set([...hits, ...pathHits])].sort();

  if (allHits.length === 0) {
    process.stdout.write("\x07");
    completerState.prefix = null;
    completerState.count = 0;
    return [[], line];
  }

  if (allHits.length === 1) {
    completerState.prefix = null;
    completerState.count = 0;
    return [[`${allHits[0]} `], line];
  }

  if (completerState.prefix === trimmed) {
    completerState.count += 1;
  } else {
    completerState.prefix = trimmed;
    completerState.count = 1;
  }

  if (completerState.count === 1) {
    process.stdout.write("\x07");
    return [[], line];
  }

  process.stdout.write(`\n${allHits.join("  ")}\n`);
  rl.prompt(true);
  return [[], line];
}

rl = readline.createInterface({
  input: process.stdin,
  output: process.stdout,
  prompt: "$ ",
  completer: completionHandler,
});

const builtins = new Set(["echo", "exit", "type", "pwd", "cd"]);

function parseCommandLine(line) {
  const tokens = [];
  let current = "";
  let quoteChar = null;
  let escapeNext = false;

  const pushCurrent = () => {
    if (current.length > 0) {
      tokens.push(current);
      current = "";
    }
  };

  for (let i = 0; i < line.length; i += 1) {
    const char = line[i];

    if (escapeNext) {
      current += char;
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
          continue;
        }
        current += char;
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
      continue;
    }

    if (char === " " || char === "\t") {
      pushCurrent();
      continue;
    }

    if (char === ">") {
      const nextChar = line[i + 1];
      if (nextChar === ">") {
        if (current === "1") {
          tokens.push("1>>");
          current = "";
        } else if (current === "2") {
          tokens.push("2>>");
          current = "";
        } else {
          pushCurrent();
          tokens.push(">>");
        }
        i += 1;
      } else if (current === "1") {
        tokens.push("1>");
        current = "";
      } else if (current === "2") {
        tokens.push("2>");
        current = "";
      } else {
        pushCurrent();
        tokens.push(">");
      }
      continue;
    }

    current += char;
  }

  pushCurrent();

  const args = [];
  let stdoutRedirect = null;
  let stderrRedirect = null;
  let stdoutAppend = false;
  let stderrAppend = false;
  for (let i = 0; i < tokens.length; i += 1) {
    const token = tokens[i];
    if (token === ">" || token === "1>") {
      if (i + 1 < tokens.length) {
        stdoutRedirect = tokens[i + 1];
        stdoutAppend = false;
        i += 1;
      }
      continue;
    }
    if (token === ">>" || token === "1>>") {
      if (i + 1 < tokens.length) {
        stdoutRedirect = tokens[i + 1];
        stdoutAppend = true;
        i += 1;
      }
      continue;
    }
    if (token === "2>") {
      if (i + 1 < tokens.length) {
        stderrRedirect = tokens[i + 1];
        stderrAppend = false;
        i += 1;
      }
      continue;
    }
    if (token === "2>>") {
      if (i + 1 < tokens.length) {
        stderrRedirect = tokens[i + 1];
        stderrAppend = true;
        i += 1;
      }
      continue;
    }
    args.push(token);
  }

  return { args, stdoutRedirect, stdoutAppend, stderrRedirect, stderrAppend };
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

function writeOutput(destination, text, append = false) {
  if (destination) {
    const flag = append ? "a" : "w";
    fs.writeFileSync(destination, text + "\n", { encoding: "utf8", flag });
  } else {
    console.log(text);
  }
}

function writeError(destination, text) {
  if (destination) {
    fs.writeFileSync(destination, text + "\n", { encoding: "utf8" });
  } else {
    console.error(text);
  }
}

rl.on("line", (line) => {
  const trimmed = line.trim();
  if (trimmed.length === 0) {
    rl.prompt();
    return;
  }

  const { args, stdoutRedirect, stdoutAppend, stderrRedirect, stderrAppend } = parseCommandLine(line);
  if (args.length === 0) {
    rl.prompt();
    return;
  }

  const cmd = args[0];
  const cmdArgs = args.slice(1);

  if (cmd === "exit") {
    rl.close();
    process.exit(0);
  }

  if (cmd === "echo") {
    writeOutput(stdoutRedirect, cmdArgs.join(" "), stdoutAppend);
    if (stderrRedirect) {
      fs.closeSync(fs.openSync(stderrRedirect, stderrAppend ? "a" : "w"));
    }
    rl.prompt();
    return;
  }

  if (cmd === "pwd") {
    writeOutput(stdoutRedirect, process.cwd(), stdoutAppend);
    if (stderrRedirect) {
      fs.closeSync(fs.openSync(stderrRedirect, stderrAppend ? "a" : "w"));
    }
    rl.prompt();
    return;
  }

  if (cmd === "cd") {
    if (cmdArgs.length > 0) {
      const dir = cmdArgs[0];
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
          writeError(stderrRedirect, `cd: ${dir}: No such file or directory`);
        }
      } catch (err) {
        writeError(stderrRedirect, `cd: ${dir}: No such file or directory`);
      }
    }
    rl.prompt();
    return;
  }

  if (cmd === "type") {
    if (cmdArgs.length > 0) {
      const target = cmdArgs[0];
      if (builtins.has(target)) {
        console.log(`${target} is a shell builtin`);
      } else {
        const resolved = findExecutable(target);
        if (resolved) {
          console.log(`${target} is ${resolved}`);
        } else {
          writeError(stderrRedirect, `${target}: not found`);
        }
      }
    }
    rl.prompt();
    return;
  }

  const resolved = findExecutable(cmd);
  if (resolved) {
    const stdio = ["inherit", "inherit", "inherit"];
    let stdoutFd;
    let stderrFd;
    if (stdoutRedirect) {
      const stdoutFlag = stdoutAppend ? "a" : "w";
      stdoutFd = fs.openSync(stdoutRedirect, stdoutFlag);
      stdio[1] = stdoutFd;
    }
    if (stderrRedirect) {
      const stderrFlag = stderrAppend ? "a" : "w";
      stderrFd = fs.openSync(stderrRedirect, stderrFlag);
      stdio[2] = stderrFd;
    }

    const child = childProcess.spawn(resolved, cmdArgs, { stdio, argv0: cmd });
    child.on("close", () => {
      if (stdoutFd !== undefined) {
        fs.closeSync(stdoutFd);
      }
      if (stderrFd !== undefined) {
        fs.closeSync(stderrFd);
      }
      rl.prompt();
    });
    child.on("error", () => {
      if (stdoutFd !== undefined) {
        fs.closeSync(stdoutFd);
      }
      if (stderrFd !== undefined) {
        fs.closeSync(stderrFd);
      }
      console.log(`${cmd}: command not found`);
      rl.prompt();
    });
    return;
  }

  console.log(`${cmd}: command not found`);
  rl.prompt();
});
