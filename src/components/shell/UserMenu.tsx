import { Link } from 'react-router-dom';
import { Avatar, AvatarFallback, AvatarImage } from '@/components/ui/avatar';
import { Button } from '@/components/ui/button';
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuLabel,
  DropdownMenuSeparator,
  DropdownMenuTrigger,
} from '@/components/ui/dropdown-menu';
import { useAuth } from '@/hooks/useAuth';
import { ChevronDown, LogIn, LogOut, Settings, User as UserIcon, Building2 } from 'lucide-react';
import { StatusBadge } from '@/components/ui/status-badge';

export function UserMenu() {
  const { user, signOut } = useAuth();

  if (!user) {
    return (
      <div className="flex items-center gap-2">
        <StatusBadge tone="neutral" dot className="hidden sm:inline-flex">Local workspace</StatusBadge>
        <Button asChild size="sm" variant="outline" className="h-8">
          <Link to="/auth">
            <LogIn className="h-3.5 w-3.5 mr-1.5" /> Sign in
          </Link>
        </Button>
      </div>
    );
  }

  const email = user.email ?? '';
  const initials = email.slice(0, 2).toUpperCase();
  const avatarUrl = typeof user.user_metadata?.avatar_url === 'string' ? user.user_metadata.avatar_url : undefined;

  return (
    <DropdownMenu>
      <DropdownMenuTrigger asChild>
        <button className="flex items-center gap-2 rounded-md px-1.5 py-1 hover:bg-muted transition-colors">
          <Avatar className="h-7 w-7 border border-border">
            <AvatarImage src={avatarUrl} alt={email} />
            <AvatarFallback className="text-[11px] font-medium">{initials}</AvatarFallback>
          </Avatar>
          <span className="hidden md:inline text-sm font-medium text-foreground max-w-[160px] truncate">{email}</span>
          <ChevronDown className="hidden md:inline h-3.5 w-3.5 text-muted-foreground" />
        </button>
      </DropdownMenuTrigger>
      <DropdownMenuContent align="end" className="w-60">
        <DropdownMenuLabel>
          <div className="flex flex-col gap-0.5">
            <span className="text-sm font-medium truncate">{email}</span>
            <span className="text-xs text-muted-foreground">Signed in</span>
          </div>
        </DropdownMenuLabel>
        <DropdownMenuSeparator />
        <DropdownMenuLabel className="text-[10px] uppercase tracking-wider text-muted-foreground font-medium">
          Workspace
        </DropdownMenuLabel>
        <DropdownMenuItem className="text-sm">
          <Building2 className="h-4 w-4 mr-2" /> Personal
          <StatusBadge tone="primary" className="ml-auto">Active</StatusBadge>
        </DropdownMenuItem>
        <DropdownMenuSeparator />
        <DropdownMenuItem asChild>
          <Link to="/profile" className="text-sm cursor-pointer">
            <UserIcon className="h-4 w-4 mr-2" /> Profile
          </Link>
        </DropdownMenuItem>
        <DropdownMenuItem asChild>
          <Link to="/settings" className="text-sm cursor-pointer">
            <Settings className="h-4 w-4 mr-2" /> Settings
          </Link>
        </DropdownMenuItem>
        <DropdownMenuSeparator />
        <DropdownMenuItem onClick={signOut} className="text-sm text-danger focus:text-danger">
          <LogOut className="h-4 w-4 mr-2" /> Sign out
        </DropdownMenuItem>
      </DropdownMenuContent>
    </DropdownMenu>
  );
}
