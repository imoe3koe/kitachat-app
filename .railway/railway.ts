import { defineRailway, project, service } from "railway/iac";
// This repository manages only its own resources in the environment. Other
// repositories export their own partial name.
// See https://docs.railway.com/infrastructure-as-code#multi-repo-projects
export const partial = "kitachat";
export default defineRailway(() => {
  const kitachat = service("kitachat", {
    // builder from CaC: "NIXPACKS"
    start: "npm start",
    healthcheck: "/api/status",
    healthcheckTimeout: 30,
  });

  return project("incredible-peace", {
    variables: { managed: true },
    resources: [kitachat],
  });
});
