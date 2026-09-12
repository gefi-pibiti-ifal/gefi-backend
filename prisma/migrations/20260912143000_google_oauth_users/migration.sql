-- Autenticacao por Google: a tabela `users` deixa de guardar credencial e passa
-- a guardar AUTORIZACAO.
--
-- A inversao de fluxo e o ponto principal: antes a pessoa se cadastrava sozinha
-- (e escolhia o proprio cargo); agora um administrador cria a linha com e-mail
-- e cargo, e a pessoa preenche nome e matricula no primeiro acesso. Por isso
-- `full_name` passa a aceitar NULL -- uma linha com nome nulo e um convite
-- pendente, nao um dado faltando por erro.
--
-- ATENCAO, DADOS EXISTENTES: `password_hash` e removido. Quem ja tinha conta so
-- volta a entrar pelo Google, com o MESMO e-mail. Contas cujo e-mail nao exista
-- no Workspace ficam inacessiveis -- confira a tabela antes de aplicar em um
-- ambiente com dados reais.

-- ---------------------------------------------------------------------------
-- 1. Normalizacao do e-mail
-- ---------------------------------------------------------------------------
-- O login compara o e-mail verificado pelo Google (sempre minusculo) com esta
-- coluna. Sem normalizar, uma linha gravada como "Fulano@ifal.edu.br" nunca
-- seria encontrada e a pessoa receberia "e-mail nao autorizado".
--
-- Se duas linhas diferirem apenas pela caixa, o UPDATE falha na constraint
-- `users_email_key` e a migracao aborta. E o comportamento desejado: unir dois
-- usuarios distintos automaticamente seria pior do que parar e pedir revisao.
UPDATE "users" SET "email" = LOWER("email") WHERE "email" <> LOWER("email");

-- ---------------------------------------------------------------------------
-- 2. Colunas novas
-- ---------------------------------------------------------------------------
ALTER TABLE "users"
  ADD COLUMN "google_sub"        TEXT,
  ADD COLUMN "picture_url"       TEXT,
  ADD COLUMN "profile_completed" BOOLEAN NOT NULL DEFAULT false,
  ADD COLUMN "revoked_at"        TIMESTAMP(3),
  ADD COLUMN "invited_by_id"     TEXT,
  ADD COLUMN "last_login_at"     TIMESTAMP(3);

-- ---------------------------------------------------------------------------
-- 3. Backfill: quem ja tem perfil preenchido nao deve cair em /complete-profile
-- ---------------------------------------------------------------------------
-- Precisa rodar ANTES do DROP de password_hash apenas por clareza de leitura;
-- o criterio e o proprio conteudo das colunas de perfil.
UPDATE "users"
   SET "profile_completed" = true
 WHERE "full_name" IS NOT NULL
   AND "full_name" <> ''
   AND "siap_registration" IS NOT NULL
   AND "siap_registration" <> '';

-- ---------------------------------------------------------------------------
-- 4. full_name passa a ser opcional (convite pendente)
-- ---------------------------------------------------------------------------
ALTER TABLE "users" ALTER COLUMN "full_name" DROP NOT NULL;

-- ---------------------------------------------------------------------------
-- 5. Remocao da senha
-- ---------------------------------------------------------------------------
-- Nao ha mais rota que a consulte: /auth/login e /auth/register deixaram de
-- existir. Manter a coluna so preservaria hashes de senha sem finalidade --
-- dado pessoal guardado a toa.
ALTER TABLE "users" DROP COLUMN "password_hash";

-- ---------------------------------------------------------------------------
-- 6. Indices e chaves
-- ---------------------------------------------------------------------------
-- Unico: impede que duas linhas reivindiquem a mesma conta Google.
CREATE UNIQUE INDEX "users_google_sub_key" ON "users"("google_sub");

-- Auditoria de quem convidou quem. SET NULL para que remover um administrador
-- nao apague o registro das pessoas que ele cadastrou.
ALTER TABLE "users"
  ADD CONSTRAINT "users_invited_by_id_fkey"
  FOREIGN KEY ("invited_by_id") REFERENCES "users"("id")
  ON DELETE SET NULL ON UPDATE CASCADE;
