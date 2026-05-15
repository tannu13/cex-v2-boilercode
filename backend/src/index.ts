import { env } from "./utils/env.js";
import app from "./server.js";

app.listen(env.port, () => {
  console.log(`Backend running on http://localhost:${env.port}`);
  console.log(`Response queue: ${env.responseQueue}`);
});
