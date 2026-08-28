-- Fontes navegaveis: arquivo original, coordenadas de localizacao e
-- rastreabilidade por trecho.
--
-- Todas as colunas novas sao NULLABLE: documentos e interacoes ja existentes
-- permanecem validos sem qualquer backfill. Documentos enviados antes desta
-- migracao ficam com file_name NULL (nao ha arquivo original guardado) e sem
-- page_map (a extracao antiga descartava as paginas).

-- AlterTable
ALTER TABLE "normative_documents"
  ADD COLUMN "file_name"       TEXT,
  ADD COLUMN "file_mime_type"  TEXT,
  ADD COLUMN "file_size"       INTEGER,
  ADD COLUMN "file_hash"       TEXT,
  ADD COLUMN "file_data"       BYTEA,
  ADD COLUMN "indexed_content" TEXT,
  ADD COLUMN "page_map"        JSONB,
  ADD COLUMN "total_pages"     INTEGER;

-- CreateTable
CREATE TABLE "response_source_excerpts" (
    "id" TEXT NOT NULL,
    "response_source_id" TEXT NOT NULL,
    "parent_chunk_id" TEXT,
    "section_header" TEXT,
    "n1_header" TEXT,
    "n2_header" TEXT,
    "citation" TEXT,
    "excerpt" TEXT NOT NULL,
    "role" TEXT,
    "rank" INTEGER NOT NULL DEFAULT 0,
    "page_start" INTEGER,
    "page_end" INTEGER,
    "char_start" INTEGER,
    "char_end" INTEGER,
    "location_precision" TEXT,
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "response_source_excerpts_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE INDEX "response_source_excerpts_response_source_id_idx" ON "response_source_excerpts"("response_source_id");

-- CreateIndex
CREATE INDEX "response_source_excerpts_parent_chunk_id_idx" ON "response_source_excerpts"("parent_chunk_id");

-- AddForeignKey
ALTER TABLE "response_source_excerpts" ADD CONSTRAINT "response_source_excerpts_response_source_id_fkey" FOREIGN KEY ("response_source_id") REFERENCES "response_sources"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "response_source_excerpts" ADD CONSTRAINT "response_source_excerpts_parent_chunk_id_fkey" FOREIGN KEY ("parent_chunk_id") REFERENCES "parent_chunks"("id") ON DELETE SET NULL ON UPDATE CASCADE;
