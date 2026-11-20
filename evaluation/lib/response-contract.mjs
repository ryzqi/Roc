/** Visible response requirements only. This adapter never receives reference answers. */
export function withQasperResponseContract(input) {
  if (input.kind !== 'qasper') throw new Error('qasper_response_input_required');
  const paper = JSON.parse(input.files['paper.json']);
  const ids = paper.paragraphs.map(paragraph => paragraph.id);
  if (ids.some(id => typeof id !== 'string') || new Set(ids).size !== ids.length) throw new Error('qasper_visible_paragraph_ids_invalid');
  return {
    ...input,
    responseContract: {
      format: 'json',
      schema: {
        type: 'object', additionalProperties: false, required: ['answer', 'evidence'],
        properties: {
          answer: { type: 'string', minLength: 1 },
          evidence: {
            type: 'array', items: { type: 'string', ...(ids.length === 0 ? {} : { enum: ids }) },
            uniqueItems: true, ...(ids.length === 0 ? { maxItems: 0 } : {})
          }
        }
      }
    }
  };
}
