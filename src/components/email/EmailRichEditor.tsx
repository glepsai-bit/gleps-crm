import { useState, useRef, useCallback, useMemo, useEffect } from 'react';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { Separator } from '@/components/ui/separator';
import { Tabs, TabsContent, TabsList, TabsTrigger } from '@/components/ui/tabs';
import {
  Bold, Italic, Underline, AlignLeft, AlignCenter, AlignRight,
  Link as LinkIcon, Image, List, ListOrdered, Type, Code, Eye, Edit2,
  Undo2, Redo2, Heading1, Heading2, Minus
} from 'lucide-react';
import {
  Popover, PopoverContent, PopoverTrigger
} from '@/components/ui/popover';

interface EmailRichEditorProps {
  value: string;
  onChange: (html: string) => void;
  placeholder?: string;
  minHeight?: string;
}

export default function EmailRichEditor({
  value,
  onChange,
  placeholder = 'Comece a escrever seu e-mail...',
  minHeight = '300px',
}: EmailRichEditorProps) {
  const editorRef = useRef<HTMLDivElement>(null);
  const [mode, setMode] = useState<'visual' | 'code'>('visual');
  const [codeValue, setCodeValue] = useState(value);
  const [linkUrl, setLinkUrl] = useState('');
  const [imageUrl, setImageUrl] = useState('');
  const [showLinkPopover, setShowLinkPopover] = useState(false);
  const [showImagePopover, setShowImagePopover] = useState(false);

  // Sync external value into editor
  useEffect(() => {
    if (editorRef.current && mode === 'visual') {
      if (editorRef.current.innerHTML !== value) {
        editorRef.current.innerHTML = value || '';
      }
    }
    if (mode === 'code') {
      setCodeValue(value);
    }
  }, [value]);

  const execCommand = useCallback((command: string, val?: string) => {
    document.execCommand(command, false, val);
    editorRef.current?.focus();
    // Sync changes
    if (editorRef.current) {
      onChange(editorRef.current.innerHTML);
    }
  }, [onChange]);

  const handleInput = useCallback(() => {
    if (editorRef.current) {
      onChange(editorRef.current.innerHTML);
    }
  }, [onChange]);

  const handleInsertLink = () => {
    if (linkUrl.trim()) {
      execCommand('createLink', linkUrl);
      setLinkUrl('');
      setShowLinkPopover(false);
    }
  };

  const handleInsertImage = () => {
    if (imageUrl.trim()) {
      execCommand('insertImage', imageUrl);
      setImageUrl('');
      setShowImagePopover(false);
    }
  };

  const handleImageUpload = (e: React.ChangeEvent<HTMLInputElement>) => {
    const file = e.target.files?.[0];
    if (!file) return;
    const reader = new FileReader();
    reader.onload = (ev) => {
      const base64 = ev.target?.result as string;
      execCommand('insertImage', base64);
    };
    reader.readAsDataURL(file);
    e.target.value = '';
  };

  const switchToCode = () => {
    if (editorRef.current) {
      setCodeValue(editorRef.current.innerHTML);
    }
    setMode('code');
  };

  const switchToVisual = () => {
    onChange(codeValue);
    setMode('visual');
    setTimeout(() => {
      if (editorRef.current) {
        editorRef.current.innerHTML = codeValue;
      }
    }, 0);
  };

  const previewHtml = useMemo(() => {
    const html = mode === 'visual' ? value : codeValue;
    return html
      .replace(/\{nome\}/g, 'João Silva')
      .replace(/\{email\}/g, 'joao@exemplo.com')
      .replace(/\{empresa\}/g, 'Empresa Exemplo');
  }, [value, codeValue, mode]);

  const ToolbarButton = ({ icon: Icon, title, onClick, active }: {
    icon: React.ElementType; title: string; onClick: () => void; active?: boolean;
  }) => (
    <Button
      variant="ghost"
      size="sm"
      className={`h-8 w-8 p-0 ${active ? 'bg-muted text-foreground' : 'text-muted-foreground hover:text-foreground'}`}
      onClick={onClick}
      title={title}
      type="button"
    >
      <Icon className="w-4 h-4" />
    </Button>
  );

  return (
    <div className="border border-border rounded-lg overflow-hidden bg-background">
      {/* Toolbar */}
      <div className="flex items-center flex-wrap gap-0.5 px-2 py-1.5 bg-muted/30 border-b border-border">
        <ToolbarButton icon={Undo2} title="Desfazer" onClick={() => execCommand('undo')} />
        <ToolbarButton icon={Redo2} title="Refazer" onClick={() => execCommand('redo')} />
        <Separator orientation="vertical" className="h-5 mx-1" />
        <ToolbarButton icon={Bold} title="Negrito" onClick={() => execCommand('bold')} />
        <ToolbarButton icon={Italic} title="Itálico" onClick={() => execCommand('italic')} />
        <ToolbarButton icon={Underline} title="Sublinhado" onClick={() => execCommand('underline')} />
        <Separator orientation="vertical" className="h-5 mx-1" />
        <ToolbarButton icon={Heading1} title="Título H1" onClick={() => execCommand('formatBlock', 'h1')} />
        <ToolbarButton icon={Heading2} title="Título H2" onClick={() => execCommand('formatBlock', 'h2')} />
        <ToolbarButton icon={Type} title="Parágrafo" onClick={() => execCommand('formatBlock', 'p')} />
        <Separator orientation="vertical" className="h-5 mx-1" />
        <ToolbarButton icon={AlignLeft} title="Alinhar à esquerda" onClick={() => execCommand('justifyLeft')} />
        <ToolbarButton icon={AlignCenter} title="Centralizar" onClick={() => execCommand('justifyCenter')} />
        <ToolbarButton icon={AlignRight} title="Alinhar à direita" onClick={() => execCommand('justifyRight')} />
        <Separator orientation="vertical" className="h-5 mx-1" />
        <ToolbarButton icon={List} title="Lista" onClick={() => execCommand('insertUnorderedList')} />
        <ToolbarButton icon={ListOrdered} title="Lista numerada" onClick={() => execCommand('insertOrderedList')} />
        <ToolbarButton icon={Minus} title="Linha horizontal" onClick={() => execCommand('insertHorizontalRule')} />
        <Separator orientation="vertical" className="h-5 mx-1" />

        {/* Link Popover */}
        <Popover open={showLinkPopover} onOpenChange={setShowLinkPopover}>
          <PopoverTrigger asChild>
            <Button variant="ghost" size="sm" className="h-8 w-8 p-0 text-muted-foreground hover:text-foreground" title="Inserir link" type="button">
              <LinkIcon className="w-4 h-4" />
            </Button>
          </PopoverTrigger>
          <PopoverContent className="w-72 p-3">
            <div className="space-y-2">
              <label className="text-xs font-medium">URL do link</label>
              <Input
                value={linkUrl}
                onChange={(e) => setLinkUrl(e.target.value)}
                placeholder="https://exemplo.com"
                onKeyDown={(e) => e.key === 'Enter' && handleInsertLink()}
              />
              <Button size="sm" className="w-full" onClick={handleInsertLink}>Inserir Link</Button>
            </div>
          </PopoverContent>
        </Popover>

        {/* Image Popover */}
        <Popover open={showImagePopover} onOpenChange={setShowImagePopover}>
          <PopoverTrigger asChild>
            <Button variant="ghost" size="sm" className="h-8 w-8 p-0 text-muted-foreground hover:text-foreground" title="Inserir imagem" type="button">
              <Image className="w-4 h-4" />
            </Button>
          </PopoverTrigger>
          <PopoverContent className="w-80 p-3">
            <div className="space-y-3">
              <div>
                <label className="text-xs font-medium">URL da imagem</label>
                <div className="flex gap-2 mt-1">
                  <Input
                    value={imageUrl}
                    onChange={(e) => setImageUrl(e.target.value)}
                    placeholder="https://..."
                    onKeyDown={(e) => e.key === 'Enter' && handleInsertImage()}
                  />
                  <Button size="sm" onClick={handleInsertImage}>Inserir</Button>
                </div>
              </div>
              <Separator />
              <div>
                <label className="text-xs font-medium">Ou faça upload</label>
                <Input
                  type="file"
                  accept="image/*"
                  onChange={handleImageUpload}
                  className="mt-1 text-xs"
                />
              </div>
            </div>
          </PopoverContent>
        </Popover>

        <div className="ml-auto flex items-center gap-1">
          <Button
            variant={mode === 'visual' ? 'default' : 'ghost'}
            size="sm"
            className="h-7 text-xs px-2"
            onClick={() => mode === 'code' ? switchToVisual() : null}
            type="button"
          >
            <Edit2 className="w-3 h-3 mr-1" /> Visual
          </Button>
          <Button
            variant={mode === 'code' ? 'default' : 'ghost'}
            size="sm"
            className="h-7 text-xs px-2"
            onClick={() => mode === 'visual' ? switchToCode() : null}
            type="button"
          >
            <Code className="w-3 h-3 mr-1" /> HTML
          </Button>
        </div>
      </div>

      {/* Editor Area */}
      {mode === 'visual' ? (
        <div
          ref={editorRef}
          contentEditable
          suppressContentEditableWarning
          className="p-4 outline-none prose prose-sm max-w-none text-foreground"
          style={{ minHeight }}
          onInput={handleInput}
          data-placeholder={placeholder}
          dangerouslySetInnerHTML={{ __html: value || '' }}
        />
      ) : (
        <textarea
          value={codeValue}
          onChange={(e) => {
            setCodeValue(e.target.value);
            onChange(e.target.value);
          }}
          className="w-full p-4 font-mono text-xs bg-background text-foreground outline-none resize-none"
          style={{ minHeight }}
          placeholder="<p>Seu HTML aqui...</p>"
        />
      )}

      {/* Variables hint */}
      <div className="px-3 py-2 bg-muted/20 border-t border-border flex items-center gap-3 text-xs text-muted-foreground">
        <span className="font-medium">Variáveis:</span>
        <code className="bg-muted px-1.5 py-0.5 rounded text-[10px]">{'{'} nome {'}'}</code>
        <code className="bg-muted px-1.5 py-0.5 rounded text-[10px]">{'{'} email {'}'}</code>
        <code className="bg-muted px-1.5 py-0.5 rounded text-[10px]">{'{'} empresa {'}'}</code>
      </div>
    </div>
  );
}
