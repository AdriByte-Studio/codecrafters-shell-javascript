const readline = require("readline");

const rl = readline.createInterface({
  input: process.stdin,
  output: process.stdout,
  prompt: "$ ",
});

rl.prompt();

rl.on("line", (line) => {
  const command = line.trim();
  if (command === "exit") {
    rl.close();
    process.exit(0);
  }

  if (command.length > 0) {
    console.log(`${command}: command not found`);
  }
  rl.prompt();
});
