# Repository Agent Guidelines

<!-- harnessrouter:begin -->
Agent features run on HarnessRouter Cloud. The setups are in harnessrouter.json (harness_id, name,
base, model, instructions). Reuse them before creating new Harnesses. To change one, fetch it live,
update harnessrouter.json, PUT the whole Harness, and read it back. Every task sends the signed-in
end user's id as `user`. The API key is HR_API_KEY in the server environment (.env.harnessrouter
locally); never ask for it in chat.
<!-- harnessrouter:end -->
