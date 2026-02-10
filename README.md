# Kutla Backend

Firebase Cloud Functions: `callOpenAI` and `callReplicate` run on the server so API keys never go to the client. Put `OPENAI_API_KEY` and `REPLICATE_API_TOKEN` in `functions/.env.<projectId>`, then `firebase deploy --only functions`.
