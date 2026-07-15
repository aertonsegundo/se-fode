// Carrega o .env ANTES de qualquer módulo que leia process.env (ex.: supabase.js).
// Precisa ser o primeiro import do servidor: em ESM os imports são avaliados
// antes do corpo do módulo, então um process.loadEnvFile() no meio do server.js
// rodaria tarde demais (o supabase.js já teria lido process.env vazio).
// Em produção (Render), as env vars vêm do painel e não há .env — tudo bem.
try { process.loadEnvFile?.(); } catch { /* sem .env: segue com o env do processo */ }
