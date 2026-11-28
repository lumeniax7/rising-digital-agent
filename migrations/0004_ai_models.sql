-- Migration 0004 : remplacer les modèles Llama retirés du catalogue Workers AI.
-- Les quotas et l'état enabled des lignes migrées sont conservés.
DELETE FROM ai_providers
WHERE task IN ('chat_reply','write_post','idea','summarize')
  AND name='llama-3.1-8b' AND model LIKE '@cf/meta/llama-%'
  AND EXISTS (SELECT 1 FROM ai_providers current
              WHERE current.task=ai_providers.task AND current.name='gemma-4-26b-a4b');
UPDATE ai_providers
SET name='gemma-4-26b-a4b', adapter='workers-ai', model='@cf/google/gemma-4-26b-a4b-it', priority=10
WHERE task IN ('chat_reply','write_post','idea','summarize')
  AND name='llama-3.1-8b'
  AND model LIKE '@cf/meta/llama-%';

DELETE FROM ai_providers
WHERE task IN ('chat_reply','write_post')
  AND name='llama-3.3-70b' AND model LIKE '@cf/meta/llama-%'
  AND EXISTS (SELECT 1 FROM ai_providers current
              WHERE current.task=ai_providers.task AND current.name='glm-4.7-flash');
UPDATE ai_providers
SET name='glm-4.7-flash', adapter='workers-ai', model='@cf/zai-org/glm-4.7-flash', priority=15
WHERE task IN ('chat_reply','write_post')
  AND name='llama-3.3-70b'
  AND model LIKE '@cf/meta/llama-%';

DELETE FROM ai_providers
WHERE task='transcribe' AND name='whisper' AND model='@cf/openai/whisper'
  AND EXISTS (SELECT 1 FROM ai_providers current
              WHERE current.task='transcribe' AND current.name='whisper-large-v3-turbo');
UPDATE ai_providers
SET name='whisper-large-v3-turbo', model='@cf/openai/whisper-large-v3-turbo'
WHERE task='transcribe' AND name='whisper' AND model='@cf/openai/whisper';
