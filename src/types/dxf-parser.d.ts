declare module "dxf-parser" {
  export type DxfEntity = {
    type: string;
    layer?: string;
    [key: string]: any;
  };

  export type DxfHeader = {
    $INSUNITS?: number;
    INSUNITS?: number;
    [key: string]: unknown;
  };

  export type ParsedDxf = {
    header?: DxfHeader;
    entities?: DxfEntity[];
  };

  export class DxfParser {
    parseSync(text: string): ParsedDxf;
  }
}
