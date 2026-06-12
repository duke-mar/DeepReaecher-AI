interface RecursiveCharacterTextSplitterOptions {
  chunkSize: number;
  chunkOverlap: number;
}

export class RecursiveCharacterTextSplitter {
  private chunkSize: number;
  private chunkOverlap: number;
  private separators: string[] = ['\n\n', '\n', '.', ',', '>', '<', ' ', ''];

  constructor(options: RecursiveCharacterTextSplitterOptions) {
    this.chunkSize = options.chunkSize;
    this.chunkOverlap = options.chunkOverlap;
  }

  async splitText(text: string): Promise<string[]> {
    return this.splitRecursive(text, this.separators);
  }

  private splitRecursive(text: string, separators: string[]): string[] {
    if (text.length <= this.chunkSize) {
      return [text];
    }

    const separator = separators[0] || '';
    const remainingSeparators = separators.slice(1);

    if (!separator) {
      // Last resort: split by character count
      const chunks: string[] = [];
      for (let i = 0; i < text.length; i += this.chunkSize) {
        chunks.push(text.slice(i, i + this.chunkSize));
      }
      return chunks;
    }

    const splits = text.split(separator);
    const chunks: string[] = [];
    let currentChunk = '';

    for (const split of splits) {
      const candidate = currentChunk ? currentChunk + separator + split : split;

      if (candidate.length <= this.chunkSize) {
        currentChunk = candidate;
      } else {
        if (currentChunk) {
          chunks.push(currentChunk);
        }
        // If single split is too large, recurse with remaining separators
        if (split.length > this.chunkSize) {
          const subChunks = this.splitRecursive(split, remainingSeparators);
          chunks.push(...subChunks.slice(0, -1));
          currentChunk = subChunks[subChunks.length - 1] || '';
        } else {
          currentChunk = split;
        }
      }
    }

    if (currentChunk) {
      chunks.push(currentChunk);
    }

    return this.mergeSplits(chunks, separator);
  }

  private mergeSplits(chunks: string[], separator: string): string[] {
    const merged: string[] = [];
    let current = '';

    for (const chunk of chunks) {
      const candidate = current ? current + separator + chunk : chunk;
      if (candidate.length <= this.chunkSize) {
        current = candidate;
      } else {
        if (current) {
          merged.push(current);
        }
        current = chunk;
      }
    }

    if (current) {
      merged.push(current);
    }

    // Apply overlap
    if (this.chunkOverlap > 0 && merged.length > 1) {
      const overlapped: string[] = [merged[0]];
      for (let i = 1; i < merged.length; i++) {
        const prev = merged[i - 1];
        const overlapText = prev.slice(-this.chunkOverlap);
        overlapped.push(overlapText + separator + merged[i]);
      }
      return overlapped;
    }

    return merged;
  }
}
