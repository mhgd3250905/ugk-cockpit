import React from 'react';
import {
  ArrowLeft, ArrowRight, BookOpen, ChevronRight, LayoutGrid, List,
  Menu, Monitor, Moon, MoreHorizontal, Plus, RefreshCw, Search, Sun, Trash2,
} from 'lucide-react';

const icons = {
  back: ArrowLeft, arrow: ArrowRight, book: BookOpen, chevron: ChevronRight,
  grid: LayoutGrid, list: List, menu: Menu, system: Monitor, moon: Moon,
  more: MoreHorizontal, plus: Plus, refresh: RefreshCw, search: Search, sun: Sun, trash: Trash2,
};

export function WorkbenchIcon({ name, size = 18, ...props }) {
  const Icon = icons[name];
  return <Icon size={size} strokeWidth={1.7} aria-hidden="true" focusable="false" {...props} />;
}
