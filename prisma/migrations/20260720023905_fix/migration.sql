-- AlterTable
ALTER TABLE "conversations" ADD COLUMN     "deleted_at" TIMESTAMP(3),
ADD COLUMN     "is_pinned" BOOLEAN NOT NULL DEFAULT false;

-- CreateTable
CREATE TABLE "parent_chunks" (
    "id" TEXT NOT NULL,
    "document_id" TEXT NOT NULL,
    "section_header" TEXT NOT NULL,
    "content" TEXT NOT NULL,
    "metadata" JSONB NOT NULL DEFAULT '{}',
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "parent_chunks_pkey" PRIMARY KEY ("id")
);

-- AddForeignKey
ALTER TABLE "parent_chunks" ADD CONSTRAINT "parent_chunks_document_id_fkey" FOREIGN KEY ("document_id") REFERENCES "normative_documents"("id") ON DELETE CASCADE ON UPDATE CASCADE;
