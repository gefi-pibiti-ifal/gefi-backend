SELECT section_header,
       length(content)
FROM parent_chunks
WHERE metadata->>'n1_header'='ANEXO VIII-B'
ORDER BY section_header;

SELECT *
FROM parent_chunks
WHERE section_header LIKE '10%';

SELECT DISTINCT section_header
FROM parent_chunks
ORDER BY section_header;