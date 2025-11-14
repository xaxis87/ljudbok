import React, {useEffect, useState} from 'react';
import {useNavigate} from 'react-router-dom';
import { useTranslation } from 'react-i18next';
import api from '../utils/api';
import BookCard from './BookCard';
import LoadingState from './LoadingState';
import ErrorState from './ErrorState';
import DashboardHeader from './DashboardHeader';
import {BookShelfEntity, BookShelfResponse} from "../interfaces/books";

interface DashboardProps {
    onLogout: () => void;
    triggerLogout?: boolean;
    setTriggerLogout?: (value: boolean) => void;
}

function Dashboard({onLogout, triggerLogout, setTriggerLogout}: DashboardProps) {
    const { t } = useTranslation();
    const navigate = useNavigate();
    const [books, setBooks] = useState<BookShelfEntity[]>([]);
    const [isLoading, setIsLoading] = useState(true);
    const [error, setError] = useState('');
    const [, setCurrentBook] = useState<BookShelfEntity | null>(null);
    const [filterStatus, setFilterStatus] = useState(-1)
    const [filteredBooks, setFilteredBooks] = useState<BookShelfEntity[]>([]);
    const [selectionMode, setSelectionMode] = useState(false);
    const [selectedBooks, setSelectedBooks] = useState<Set<string>>(new Set());
    const [downloadingBooks, setDownloadingBooks] = useState<Set<string>>(new Set());
    const [downloadedBooks, setDownloadedBooks] = useState<Set<string>>(new Set());

    useEffect(() => {
        loadBookshelf();
    }, []);

    useEffect(() => {
        if (books.length === 0) return;
        let _filterStatus = filterStatus === -1 ? [1,2] : [filterStatus];
        setFilteredBooks(
            books.filter(book => _filterStatus.includes(+book.status))
        );
    }, [filterStatus, books])

    const loadBookshelf = async () => {
        try {
            setIsLoading(true);
            const response = await api.get<BookShelfResponse>('/bookshelf');
            setBooks(response.data.books);
        } catch (error: any) {
            setError(error.response?.data?.error || t('dashboard.loadError'));
        } finally {
            setIsLoading(false);
        }
    };

    const handleBookSelect = (book: BookShelfEntity) => {
        setCurrentBook(book);
        navigate(`/book/${book.abook.id}`, {
            state: {
                book: book
            }
        });
    };

    const handleBookShelfStatus = (
        status: BookShelfEntity['status']
    ) => {
        setFilterStatus(status);
    };

    const toggleSelectionMode = () => {
        setSelectionMode(!selectionMode);
        if (selectionMode) {
            // Clear selections when exiting selection mode
            setSelectedBooks(new Set());
        }
    };

    const handleSelectToggle = (bookId: string) => {
        setSelectedBooks(prev => {
            const newSet = new Set(prev);
            if (newSet.has(bookId)) {
                newSet.delete(bookId);
            } else {
                newSet.add(bookId);
            }
            return newSet;
        });
    };

    const handleSelectAll = () => {
        if (selectedBooks.size === filteredBooks.length) {
            setSelectedBooks(new Set());
        } else {
            setSelectedBooks(new Set(filteredBooks.map(book => String(book.abook.id))));
        }
    };

    const handleBatchDownload = async () => {
        const booksToDownload = Array.from(selectedBooks);

        for (const bookId of booksToDownload) {
            if (downloadedBooks.has(bookId)) {
                continue; // Skip already downloaded books
            }

            // Find the book object to get title and author
            const book = books.find(b => String(b.abook.id) === bookId);
            if (!book) continue;

            try {
                setDownloadingBooks(prev => new Set(prev).add(bookId));

                const response = await api.post('/download', {
                    bookId,
                    title: book.book.name,
                    author: book.book.authorsAsString
                });

                if (response.data.success) {
                    setDownloadedBooks(prev => new Set(prev).add(bookId));
                }
            } catch (error: any) {
                console.error(`Failed to download book ${bookId}:`, error);
                setError(`Failed to download some books. Please try again.`);
            } finally {
                setDownloadingBooks(prev => {
                    const newSet = new Set(prev);
                    newSet.delete(bookId);
                    return newSet;
                });
            }
        }

        // Clear selections after download
        setSelectedBooks(new Set());
        setSelectionMode(false);
    };

    if (isLoading) {
        return <LoadingState message={t('dashboard.loading')}/>;
    }

    if (error) {
        return <ErrorState error={error} onRetry={() => window.location.reload()}/>;
    }

    return (
        <div className="min-h-screen bg-black text-white">
            <DashboardHeader
                onLogout={onLogout}
                triggerLogout={triggerLogout}
                setTriggerLogout={setTriggerLogout}
            />

            {/* Main Content */}
            <main className="max-w-4xl mx-auto py-6 px-4 pb-32">
                {books.length === 0 ? (
                    <div className="text-center py-20">
                        <div className="text-gray-400 text-xl mb-4">{t('dashboard.noBooks')}</div>
                        <p className="text-gray-500">{t('dashboard.emptyLibrary')}</p>
                    </div>
                ) : (
                    <>
                        {/* Batch Download Controls */}
                        <div className="flex flex-wrap gap-3 mb-4">
                            <button
                                onClick={toggleSelectionMode}
                                className={`px-4 py-2 rounded-full transition-colors duration-200 ${
                                    selectionMode
                                        ? 'bg-orange-600 text-white hover:bg-orange-700'
                                        : 'bg-gray-700 text-white hover:bg-gray-600'
                                }`}
                            >
                                {selectionMode ? t('dashboard.batchDownload.exitSelection') || 'Exit Selection' : t('dashboard.batchDownload.selectBooks') || 'Select Books'}
                            </button>

                            {selectionMode && (
                                <>
                                    <button
                                        onClick={handleSelectAll}
                                        className="px-4 py-2 bg-gray-700 text-white rounded-full hover:bg-gray-600 transition-colors duration-200"
                                    >
                                        {selectedBooks.size === filteredBooks.length
                                            ? (t('dashboard.batchDownload.deselectAll') || 'Deselect All')
                                            : (t('dashboard.batchDownload.selectAll') || 'Select All')}
                                    </button>

                                    {selectedBooks.size > 0 && (
                                        <button
                                            onClick={handleBatchDownload}
                                            disabled={downloadingBooks.size > 0}
                                            className={`px-4 py-2 rounded-full transition-colors duration-200 flex items-center gap-2 ${
                                                downloadingBooks.size > 0
                                                    ? 'bg-gray-500 text-gray-300 cursor-not-allowed'
                                                    : 'bg-green-600 text-white hover:bg-green-700'
                                            }`}
                                        >
                                            <svg className="w-5 h-5" xmlns="http://www.w3.org/2000/svg" fill="none" viewBox="0 0 24 24" stroke="currentColor">
                                                <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M4 16v1a3 3 0 003 3h10a3 3 0 003-3v-1m-4-4l-4 4m0 0l-4-4m4 4V4"/>
                                            </svg>
                                            <span>
                                                {t('dashboard.batchDownload.downloadSelected') || 'Download Selected'} ({selectedBooks.size})
                                            </span>
                                        </button>
                                    )}

                                    {downloadingBooks.size > 0 && (
                                        <div className="px-4 py-2 bg-blue-600 text-white rounded-full flex items-center gap-2">
                                            <svg className="w-5 h-5 animate-spin" xmlns="http://www.w3.org/2000/svg" fill="none" viewBox="0 0 24 24" stroke="currentColor">
                                                <circle className="opacity-25" cx="12" cy="12" r="10" stroke="currentColor" strokeWidth="4"></circle>
                                                <path className="opacity-75" fill="currentColor" d="M4 12a8 8 0 018-8v4a4 4 0 00-4 4H4z"></path>
                                            </svg>
                                            <span>
                                                {t('dashboard.batchDownload.downloading') || 'Downloading'} ({downloadingBooks.size})
                                            </span>
                                        </div>
                                    )}
                                </>
                            )}
                        </div>

                        <div className="flex flex-wrap gap-3 mb-6">
                            { filterStatus !== -1 && (
                                <button
                                    onClick={() => handleBookShelfStatus(-1)}
                                    className="bg-gray-600 hover:bg-gray-500 text-white px-4 py-2 rounded-full transition-colors duration-200 flex items-center justify-center w-10 h-10"
                                >
                                    ×
                                </button>
                            )}
                            {[
                                { status: 1, label: 'dashboard.filters.notStarted' },
                                { status: 2, label: 'dashboard.filters.started' },
                                { status: 3, label: 'dashboard.filters.concluded' }
                            ].map(({ status, label }) => (
                                <button
                                    key={status}
                                    onClick={() => handleBookShelfStatus(status)}
                                    className={`px-4 py-2 rounded-full transition-colors duration-200 ${
                                        filterStatus === status
                                            ? 'bg-white text-black'
                                            : 'bg-gray-700 hover:bg-gray-600 text-white'
                                    }`}
                                >
                                    {t(label)}
                                </button>
                            ))}
                        </div>
                        <div className="space-y-8">
                            {filteredBooks.map((book) => (
                                <BookCard
                                    key={book.abook.id}
                                    book={book}
                                    onBookSelect={handleBookSelect}
                                    selectionMode={selectionMode}
                                    isSelected={selectedBooks.has(String(book.abook.id))}
                                    onSelectToggle={handleSelectToggle}
                                    isDownloading={downloadingBooks.has(String(book.abook.id))}
                                    isDownloaded={downloadedBooks.has(String(book.abook.id))}
                                />
                            ))}
                        </div>
                    </>
                )}
            </main>
        </div>
    );
}

export default Dashboard;
